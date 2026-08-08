// ADR-0088 — internal throughput-gap watchdog endpoint.
//
// The thin Pacific-aware daemon `scripts/equipment-throughput-gap-cron.mjs` POSTs
// here once per day at 08:30 America/Los_Angeles. All the real work (working-day
// resolution, the cutover and pilot gates, the ledger, the notifyStaff send) runs
// compiled inside the Next app via `runThroughputGapScan` — the daemon imports
// no TS.
//
// INTERNAL-ONLY: mirrors /api/internal/survey/reminder-tick verbatim. Any request
// carrying a `cf-connecting-ip` header (i.e. arriving via the public Cloudflare
// tunnel) gets a 404. The cron reaches it over the compose network. An
// `INTERNAL_CRON_TOKEN` bearer is mandatory in production (defense in depth).
//
// IDEMPOTENT BY CONSTRUCTION: the `equipment_throughput_gap_alerts` (site,
// gap_date) unique means a re-fire, a container restart, or a hand-run `curl`
// re-POST sends nothing a second time. It is safe to call this route by hand.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runThroughputGapScan } from '@/lib/equipment/throughput-gap';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const summary = await runThroughputGapScan();
  log.info(
    {
      scanDate: summary.scanDateISO,
      skippedWeekend: summary.skippedWeekend,
      alerted: summary.outcomes.filter((o) => o.status === 'alerted').length,
      failed: summary.outcomes.filter((o) => o.status === 'failed').length,
      skipped: summary.outcomes.filter((o) => o.status.startsWith('skipped_')).length,
    },
    '[throughput-gap] scan complete',
  );
  return NextResponse.json(summary);
}
