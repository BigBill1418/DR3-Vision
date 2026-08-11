// ADR-0092 — internal stale-claim watchdog endpoint.
//
// The thin Pacific-aware daemon `scripts/stale-claim-cron.mjs` POSTs here once
// per day at 16:45 America/Los_Angeles. All the real work — the pilot gate, the
// activity computation, the ledger, the notifyStaff send — runs compiled inside
// the Next app via `runStaleClaimScan`; the daemon imports no TS.
//
// INTERNAL-ONLY: mirrors /api/internal/equipment/throughput-gap verbatim. Any
// request carrying a `cf-connecting-ip` header (i.e. arriving via the public
// Cloudflare tunnel) gets a 404. The cron reaches it over the compose network,
// and an `INTERNAL_CRON_TOKEN` bearer is mandatory in production.
//
// IDEMPOTENT BY CONSTRUCTION: the `stale_claim_alerts.load_id` unique means a
// re-fire, a container restart, or a hand-run `curl` re-POST reports nothing a
// second time. It is safe to call this route by hand — which is how it gets
// smoke-tested on deploy.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runStaleClaimScan } from '@/lib/loads/stale-claim-scan';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const summary = await runStaleClaimScan();
  log.info(
    {
      scannedAtISO: summary.scannedAtISO,
      alerted: summary.outcomes.filter((o) => o.status === 'alerted').length,
      failed: summary.outcomes.filter((o) => o.status === 'failed').length,
      staleTotal: summary.outcomes.reduce((n, o) => n + (o.staleCount ?? 0), 0),
    },
    '[stale-claim] scan complete',
  );
  return NextResponse.json(summary);
}
