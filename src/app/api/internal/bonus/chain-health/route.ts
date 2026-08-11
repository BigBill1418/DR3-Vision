// ADR-0019.4 — signature-chain health sweep endpoint.
//
// POSTed once a day at 06:30 PT by `scripts/bonus-chain-health-cron.mjs`, ahead
// of the 07:10 t1 escalation tier so a broken chain is known BEFORE the ladder
// that depends on it starts running. Writes a ledger row per site and pages on
// the leading edge of an unhealthy transition.
//
// Reachability: `/api/internal/bonus/` is already exempted in public-paths.ts
// (the bonus cron endpoints), so this route inherits that exemption — and
// public-paths.test.ts now sweeps every /api/internal/**/route.ts on disk and
// asserts each is reachable by its session-less caller, so a future move of this
// file cannot silently 401 the way ADR-0092 did.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guardInternalCron } from '@/lib/internal-auth';
import { runChainHealthSweep } from '@/lib/bonus/chain-health';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await runChainHealthSweep(prisma);

  log.info(
    {
      overall: result.overall,
      paged: result.paged,
      ntfyDropped: result.ntfyDropped,
      sites: result.sites.map((s) => ({
        site: s.siteCode,
        status: s.status,
        n: s.findings.length,
      })),
    },
    '[chain-health] sweep complete',
  );

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
