// Internal weekly fuel-price fetch endpoint (ADR-0040 D4).
//
// The thin Pacific-aware daemon `scripts/fuel-price-cron.mjs` POSTs here once a week
// (Tuesday 06:00 America/Los_Angeles). The real work (EIA fetch + `fuel_prices`
// upsert + fingerprinted failure paging) runs compiled inside the Next app via
// `runFuelFetchTick`; the daemon imports no TS.
//
// INTERNAL-ONLY: mirrors /api/internal/survey/reminder-tick verbatim. Any request
// carrying a `cf-connecting-ip` header (public Cloudflare tunnel) gets a 404. The
// cron reaches it over the compose network. An optional `INTERNAL_CRON_TOKEN` adds a
// bearer check when set (defense in depth). Idempotent: the tick upserts by week and
// never overwrites a manual entry, so an early/late fire or a restart-triggered
// re-POST is safe.

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runFuelFetchTick } from '@/lib/billing-rates/fuel-fetch';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const summary = await runFuelFetchTick();
  log.info(
    {
      ok: summary.ok,
      reason: summary.reason,
      fetched: summary.fetched,
      upserted: summary.upserted,
      skipped_manual: summary.skipped_manual,
      paged: summary.paged,
    },
    '[fuel-fetch] tick complete',
  );
  return NextResponse.json(summary);
}
