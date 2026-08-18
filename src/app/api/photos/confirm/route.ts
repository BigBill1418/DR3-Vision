import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireOperatorOrGrantAtLoadSite, type LoadPhotoAccess } from '@/lib/load-photo-guard';
import { withIdempotency } from '@/lib/idempotency';
import { readIdempotencyKey } from '@/lib/loads/route-helpers';
import { MAX_PHOTOS_PER_KIND, canAddPhoto } from '@/lib/loads/photo-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ADR-0109 — the load already holds `MAX_PHOTOS_PER_KIND` photos of this kind.
 *
 * Thrown from INSIDE the `$transaction` so the rollback takes the idempotency
 * claim with it. That is the point: nothing was written, so nothing may be
 * remembered as written. Were the key left claimed with a success body, the
 * refused photo's own retry would replay a 200 it never earned and the queue row
 * would delete itself having stored nothing.
 */
class PhotoLimitReached extends Error {
  constructor(readonly held: number) {
    super('photo_limit_reached');
  }
}

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

  let access: LoadPhotoAccess;
  let idempotencyKey: string | null;
  try {
    // ADR-0078 Am.1 — SITE-scoped, matching /api/photos/upload-url exactly.
    // ADR-0086 D2 — session OR grant, again matching the mint exactly.
    // These two MUST move together; see the note at the mint call site.
    //
    // `storage_key` is handed to the guard so D3's PREFIX check runs here and
    // only here: this is the route that writes the row naming the object, and
    // the mint has not produced a key yet when it runs.
    access = await requireOperatorOrGrantAtLoadSite(req, {
      loadId: parsed.data.load_id,
      kind: parsed.data.kind,
      storageKey: parsed.data.storage_key,
    });
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

  // ADR-0086 D1 — under grant-auth the presented key MUST be the one the grant
  // was minted over. This is what "single-use by construction" actually means:
  // the grant names a key, that key is claimed in the same transaction as the
  // insert below, and a second redemption of the same grant therefore returns
  // the stored response instead of writing a second `load_photos` row.
  //
  // Refused rather than defaulted when absent. A grant-auth confirm carrying no
  // key would be an UNBOUNDED write — the same bearer string could land an
  // unlimited number of photos — which is the one property the design has to
  // hold. Under session-auth nothing changes: the key stays optional exactly as
  // it is today.
  if (access.via === 'grant' && idempotencyKey !== access.grantIdempotencyKey) {
    return NextResponse.json({ error: 'grant_idempotency_key_mismatch' }, { status: 403 });
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
  let outcome;
  try {
    outcome = await prisma.$transaction((tx) =>
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
          // ── ADR-0109 — the ceiling, and it is checked HERE and nowhere else ──
          //
          // ## Why inside the `withIdempotency` callback
          //
          // `withIdempotency` runs this callback ONLY when it just claimed the
          // key; a replay of an already-claimed key returns the stored response
          // above without ever reaching here. So a photo whose confirm landed and
          // whose response was lost still drains on its next sweep, and its own
          // already-written row can never be counted as the thing that blocks it.
          // Hoisting this check above the claim would make every such replay
          // permanently refused — a fourth-photo guard that eats a FIRST photo.
          //
          // ## Why NOT at `/api/photos/upload-url`
          //
          // Refusing the mint would save an R2 PUT of bytes that can never be
          // confirmed, and that is genuinely tempting. It is wrong for the same
          // reason: `replayUpload` re-mints on every photo older than eight
          // minutes, INCLUDING one whose confirm already succeeded. A capped mint
          // answers 4xx, `classify()` in `offline-queue.ts` calls that a
          // conflict, conflicts are never retried — and a photo that is already
          // safely in the database parks on the conflicts screen forever. The
          // wasted PUT is bytes; that would be evidence.
          //
          // ## Why the advisory lock
          //
          // Count-then-insert is not atomic under READ COMMITTED, which is
          // Postgres's default and this application's. Two drains of one load —
          // an ordinary event since ADR-0078 Am.1 made the gate site-scoped, so
          // two iPads may hold queued photos for the same load — can both read 2
          // and both insert, landing 4. `SELECT ... FOR UPDATE` on the parent
          // would work; an advisory lock is the pattern this codebase already
          // uses for exactly this shape (`recycling-rates.ts`) and it does not
          // take a row lock on a load an operator may be writing to concurrently.
          // Transaction-scoped, so it is released by the same commit or rollback
          // that decides the insert.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`load-photo:${parsed.data.load_id}:${parsed.data.kind}`})::bigint)`;
          const held = await tx.loadPhoto.count({
            where: { load_id: parsed.data.load_id, kind: parsed.data.kind },
          });
          if (!canAddPhoto(held)) throw new PhotoLimitReached(held);

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
  } catch (e) {
    // ADR-0109 — **409, and specifically not 401 and not a bare 403.**
    //
    // `offline-queue.ts` classifies 401 as `auth:` — the state the floor chrome
    // renders as "sign in and this will send" — and a full trailer's worth of
    // signing in will never make room for a fourth photo. Every other hard 4xx
    // is a `conflict:`, which is never retried and surfaces on the conflicts
    // screen for a person to decide about. That is the honest classification
    // here: the photo is real, it is on the device, and the load has no room
    // for it. 409 says which of those it is.
    //
    // The count is in the body because "the limit is 3" and "you already have
    // 3" are different sentences to an operator holding a photo they cannot
    // send, and only the second explains why the button was already gone.
    if (e instanceof PhotoLimitReached) {
      return NextResponse.json(
        { error: 'photo_limit_reached', limit: MAX_PHOTOS_PER_KIND, held: e.held },
        { status: 409 },
      );
    }
    throw e;
  }

  return NextResponse.json(outcome.body, { status: outcome.statusCode });
}
