// ADR-0078 — TTL sweep for `idempotency_keys`.
//
// The keys table is a receipt book, not a ledger. A receipt's only job is to
// answer "did this exact write already land?", and that question stops being
// asked once the device that minted the key has synced — in practice within
// minutes, at worst across a shift change. Seven days is generous by an order of
// magnitude and exists so an iPad that spends a long weekend switched off in a
// locker still replays correctly on Monday rather than double-writing.
//
// This is the ONLY writer permitted to delete from this table, and the retention
// floor is a constant here rather than a request parameter — a sweep whose
// horizon the caller chooses is one bad call away from deleting live keys.
//
// Guarded by `guardInternalCron` exactly like every other internal route
// (ADR-0054): constant-time bearer comparison, 404 on a request that arrived
// through Cloudflare, and a 503 + page if the token is unset in production.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Days a receipt is kept. Deliberately not caller-controllable. */
const RETENTION_DAYS = 7;

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { created_at: { lt: cutoff } },
  });

  log.info(
    { deleted: count, cutoff: cutoff.toISOString(), retention_days: RETENTION_DAYS },
    '[idempotency] TTL sweep complete',
  );
  return NextResponse.json({
    deleted: count,
    cutoff: cutoff.toISOString(),
    retention_days: RETENTION_DAYS,
  });
}
