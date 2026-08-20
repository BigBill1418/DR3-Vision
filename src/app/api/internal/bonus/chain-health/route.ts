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
import { redrivePayrollDeliveries } from '@/lib/bonus/payroll-delivery';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const result = await runChainHealthSweep(prisma);

  // ADR-0117 — the payroll delivery re-drive rides this cron rather than
  // getting its own. This fire is at 06:30 PT, which is the earliest point in
  // the payroll morning and FORTY MINUTES ahead of the t1 escalation tier: a
  // delivery re-driven here has the whole ladder still in front of it, and an
  // ambiguous one puts a person on it two and a half hours before the 09:00 PT
  // deadline rather than after. It also runs on non-payroll mornings, so a
  // delivery lost on any other day is recovered the next morning instead of
  // waiting for the fortnight to come round.
  //
  // Never allowed to fail the chain-health sweep it rides on: the two answer
  // different questions and a broken re-drive must not suppress the report on
  // the signature chain.
  let payrollRedrive: Awaited<ReturnType<typeof redrivePayrollDeliveries>> | null = null;
  try {
    payrollRedrive = await redrivePayrollDeliveries();
  } catch (err) {
    log.error({ err }, '[chain-health] payroll delivery re-drive failed (ADR-0117)');
  }

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
      payrollRedrive: payrollRedrive
        ? {
            scanned: payrollRedrive.scanned,
            redriven: payrollRedrive.redriven,
            ambiguous: payrollRedrive.ambiguous,
          }
        : 'failed',
    },
    '[chain-health] sweep complete',
  );

  return NextResponse.json(
    { ...result, payrollRedrive },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
