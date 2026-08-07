import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireOperatorOwnsLoad } from '@/lib/load-photo-guard';
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

  let owner: { operatorUserId: string; siteId: string };
  let idempotencyKey: string | null;
  try {
    owner = await requireOperatorOwnsLoad(parsed.data.load_id);
    idempotencyKey = readIdempotencyKey(req);
  } catch (e) {
    if (e instanceof Response) {
      // `requireOperatorOwnsLoad` sets a BODY and no statusText, so reading
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
        actorUserId: owner.operatorUserId,
        siteId: owner.siteId,
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
          },
          select: { id: true },
        });
        return { id: created.id };
      },
    ),
  );

  return NextResponse.json(outcome.body, { status: outcome.statusCode });
}
