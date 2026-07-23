// ADR-0058 D4 — internal live-floor probe for the backfill invariance gate.
//
// `onHand` is app-side (`@/lib/inventory/running-balance`, full Prisma + time).
// The one-shot bridge backfill (`scripts/mymrc-processed-bridge-backfill.mjs`)
// runs its DB writes with its own PrismaClient, then MUST prove the LIVE FLOOR did
// not move (every backfilled day is ≤ the latest physical anchor, so `{ gt }`
// excludes them — see ADR-0058 D4). It calls this route BEFORE and AFTER with the
// SAME `asOf` and asserts the returned floor is byte-identical. Any drift aborts
// the go-live: it would mean a bridged row landed at/after the anchor unexpectedly
// (a processed_date encoding bug) and must be investigated.
//
// READ-ONLY: computes `onHand` and returns it; it records nothing and can never
// move a billing figure. INTERNAL-ONLY: `guardInternalCron` 404s any public-tunnel
// request (cf-connecting-ip) and requires the bearer in prod — same posture as the
// daily-report cron route.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { onHand } from '@/lib/inventory/running-balance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  // The site to probe. Both sites are accepted; Eugene simply has no bridged rows.
  siteCode: z.enum(['woodland', 'eugene']),
  // Optional fixed as-of instant (ISO). The gate passes the SAME value before and
  // after so the comparison isolates the bridge's writes from clock advance. Default
  // = now.
  asOf: z.string().datetime().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }

  const site = await prisma.site.findFirst({
    where: { code: parsed.data.siteCode },
    select: { id: true, code: true },
  });
  if (!site) {
    return NextResponse.json({ error: 'unknown_site' }, { status: 404 });
  }

  const asOf = parsed.data.asOf ? new Date(parsed.data.asOf) : new Date();
  const floor = await onHand(site.id, asOf);

  // Strings, not numbers — byte-identical Decimal comparison is the whole point of
  // the gate (a float round-trip could mask a sub-unit drift).
  return NextResponse.json({
    site: site.code,
    asOf: asOf.toISOString(),
    program: floor.program.toString(),
    nonProgram: floor.nonProgram.toString(),
    total: floor.total.toString(),
    anchorPool: floor.anchorPool ?? null,
  });
}
