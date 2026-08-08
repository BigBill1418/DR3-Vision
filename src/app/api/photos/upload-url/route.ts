import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mintUploadUrl } from '@/lib/r2';
import { requireOperatorOrGrantAtLoadSite, type LoadPhotoAccess } from '@/lib/load-photo-guard';
import { mintPhotoGrant, PHOTO_GRANT_HEADER, verifyPhotoGrant } from '@/lib/photo-grant';
import { isQueueId } from '@/lib/ulid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PHOTO_KINDS = ['bol', 'weight_ticket', 'door_open', 'concern', 'rejection'] as const;

// Constrain content_type to an image allowlist (audit 2026-07-16 · UPLOAD). The
// value is set verbatim on the presigned R2 PUT (src/lib/r2.ts), so an arbitrary
// string let a caller park HTML/SVG that R2 would then serve with an active
// Content-Type on the public photos host. Mirrors r2.ts SAFE_EXT.
const CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

const schema = z.object({
  load_id: z.string().min(1),
  kind: z.enum(PHOTO_KINDS),
  content_type: z.enum(CONTENT_TYPES),
  // ADR-0086 D1 — the client-minted queue id this photo already carries. Bound
  // INTO the grant, which is what makes a grant single-use by construction: the
  // confirm it authorises must present this same key, and `withIdempotency`
  // turns a second redemption into a stored-response replay rather than a
  // second `load_photos` row.
  //
  // Optional, and its absence is not an error: a caller that does not supply one
  // gets exactly today's behaviour (a presign, no grant). That is the whole
  // fail-soft posture — the grant is additive to a path that already works.
  idempotency_key: z.string().refine(isQueueId, 'malformed').optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  let access: LoadPhotoAccess;
  try {
    // ADR-0078 Am.1 — SITE-scoped, not owner-scoped. ADR-0086 D2 — session OR a
    // capture-time grant. Mint and confirm must move together: a relaxed mint
    // with a strict confirm PUTs bytes to R2 and then refuses to write the row,
    // which is strictly worse than today — orphaned objects, no record, and a
    // queue row that still cannot drain. That is why BOTH routes changed to the
    // same predicate in the same commit, and why the symmetry test exists.
    access = await requireOperatorOrGrantAtLoadSite(req, {
      loadId: parsed.data.load_id,
      kind: parsed.data.kind,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const minted = await mintUploadUrl({
    loadId: parsed.data.load_id,
    kind: parsed.data.kind,
    contentType: parsed.data.content_type,
  });

  // ADR-0086 D2 — issue (or RE-issue) the grant alongside the presign.
  //
  // The drain re-mints on every photo older than eight minutes, so this route is
  // on the path of every queued photo. Re-issuing here is what keeps a grant
  // usable across a multi-day queue life, and it is bounded by the rule below.
  const presented =
    access.via === 'grant' ? verifyPhotoGrant(req.headers.get(PHOTO_GRANT_HEADER)) : null;
  const idempotencyKey =
    access.via === 'grant' ? access.grantIdempotencyKey : (parsed.data.idempotency_key ?? null);

  // Under grant-auth the grant's key is authoritative. A body key that DISAGREES
  // is refused rather than ignored: silently preferring one of two conflicting
  // keys is how a caller ends up believing it claimed a write it did not.
  if (
    access.via === 'grant' &&
    parsed.data.idempotency_key !== undefined &&
    parsed.data.idempotency_key !== access.grantIdempotencyKey
  ) {
    return NextResponse.json({ error: 'grant_idempotency_key_mismatch' }, { status: 403 });
  }

  const upload_grant =
    idempotencyKey === null
      ? null
      : mintPhotoGrant({
          loadId: access.loadId,
          kind: parsed.data.kind,
          actorUserId: access.actorUserId,
          siteId: access.siteId,
          idempotencyKey,
          // D2 — a re-issue carries the ORIGINAL expiry forward, never a fresh
          // 14-day window. Otherwise a device that sweeps hourly refreshes its
          // own credential indefinitely and the expiry means nothing at all.
          ...(presented?.ok ? { expiresAtSeconds: presented.payload.exp } : {}),
        });

  // `upload_grant` is omitted, not null-valued, when there is nothing to issue —
  // no secret provisioned, or no idempotency key to bind. Either way the caller
  // gets exactly today's response shape plus nothing, which is what keeps the
  // session path working unchanged on an unconfigured deployment.
  return NextResponse.json(upload_grant ? { ...minted, upload_grant } : minted);
}
