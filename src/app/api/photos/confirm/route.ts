import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireOperatorAtLoadSite, type LoadSiteAccess } from '@/lib/load-photo-guard';
import { withIdempotency } from '@/lib/idempotency';
import { readIdempotencyKey } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PHOTO_KINDS = ['bol', 'weight_ticket', 'door_open', 'concern', 'rejection'] as const;

const schema = z.object({
  load_id: z.string().min(1),
  kind: z.enum(PHOTO_KINDS),
  storage_key: z.string().min(1).max(512),
  byte_size: z.number().int().min(0).max(50_000_000).nullable().optional(),
  width: z.number().int().min(1).max(20_000).nullable().optional(),
  height: z.number().int().min(1).max(20_000).nullable().optional(),
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

  let access: LoadSiteAccess;
  let idempotencyKey: string | null;
  try {
    // ADR-0078 Am.1 — SITE-scoped, matching /api/photos/upload-url exactly.
    // These two MUST move together; see the note at the mint call site.
    access = await requireOperatorAtLoadSite(parsed.data.load_id);
    idempotencyKey = readIdempotencyKey(req);
  } catch (e) {
    if (e instanceof Response) {
      // The guard sets a BODY and no statusText, so reading
      // statusText alone flattened every refusal to "forbidden" — including the
      // 404, whose body said `load not found`. That distinction is what tells
      // an operator staring at the conflicts screen whether the load moved or
      // the session lapsed.
      return e;
    }
    throw e;
  }

  // ADR-0078 D3 — the create was UNCONDITIONAL, and the offline queue replays
  // this endpoint. Worse, `replayUpload` re-mints a FRESH R2 storage_key before
  // replaying, so the row it wrote the second time differed from the first in
  // the one column that might otherwise have caught it — there is no natural key
  // here to dedupe on. A photo whose confirm succeeded but whose response was
  // lost therefore produced two `load_photos` rows, forever.
  //
  // The key is claimed in the same transaction as the insert. The re-minted R2
  // object from a replay is left orphaned rather than reused: an unreferenced
  // object costs bytes, a duplicate row costs a manager believing a load was
  // photographed twice. The retention purge already sweeps unreferenced keys.
  //
  // The request hash covers `load_id` + `kind` ONLY, and that omission is
  // load-bearing rather than lazy: `storage_key` legitimately CHANGES between
  // the first attempt and its replay, so hashing it would make every replay of
  // a re-minted photo look like key reuse and answer 409 — turning the fix into
  // a second, louder bug.
  const outcome = await prisma.$transaction((tx) =>
    withIdempotency(
      {
        key: idempotencyKey,
        scope: 'operator.photo.confirm',
        // The UPLOADING session, never the load owner. Two reasons: a replay
        // must be pinned to the principal that claimed the key (a key is a
        // bearer string), and pinning to the load owner would let any same-site
        // operator replay a key they never claimed.
        //
        // Residual, stated rather than hidden: if operator A queues a photo, B
        // drains it and B's response is lost, A's later retry of the SAME key
        // is a different actor and earns 409 `idempotency_key_reused`. The row
        // then parks as a visible conflict instead of writing a duplicate —
        // degrading into the ADR-0078 conflict path, which is the safe
        // direction and is exactly what that path is for.
        actorUserId: access.actorUserId,
        siteId: access.siteId,
        payload: { load_id: parsed.data.load_id, kind: parsed.data.kind },
        tx,
        statusCode: 200,
      },
      async () => {
        const created = await tx.loadPhoto.create({
          data: {
            load_id: parsed.data.load_id,
            kind: parsed.data.kind,
            storage_key: parsed.data.storage_key,
            byte_size: parsed.data.byte_size ?? null,
            width: parsed.data.width ?? null,
            height: parsed.data.height ?? null,
            captured_at: new Date(),
            // ADR-0078 Am.1 — the durable attribution record. Written on EVERY
            // confirm, self or cross-operator: the audit row below is only for
            // the exceptional case, and a column that is only sometimes
            // populated cannot answer "who uploaded this?" for the ordinary
            // one.
            uploaded_by: access.actorUserId,
          },
          select: { id: true },
        });

        // ADR-0037 noise discipline: an audit row ONLY when the uploader is not
        // the load's assigned operator. A row per confirm would add ~100/day of
        // "operator did the thing they were assigned to do", burying the case a
        // person would actually want to find. `uploaded_by` above is the
        // durable record for every upload; this marks the exception.
        if (access.loadOwnerUserId !== null && access.actorUserId !== access.loadOwnerUserId) {
          await tx.auditLog.create({
            data: {
              actor_user_id: access.actorUserId,
              action: 'insert',
              table_name: 'load_photos',
              row_id: created.id,
              after: {
                cross_operator: true,
                load_id: parsed.data.load_id,
                kind: parsed.data.kind,
                uploaded_by: access.actorUserId,
                load_assigned_to: access.loadOwnerUserId,
              },
            },
          });
        }

        return { id: created.id };
      },
    ),
  );

  return NextResponse.json(outcome.body, { status: outcome.statusCode });
}
