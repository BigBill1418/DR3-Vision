// Internal daily-production-report cron endpoint (ADR-0030).
//
// The fleet daemon (`scripts/bonus-daily-report.mjs`) is a thin Pacific
// scheduler that sleeps until the soonest enabled site's send time, then POSTs
// here. The real work (due-check, idempotency, build, send, log-write) runs
// compiled inside the Next app via `runDailyReportFire` — the daemon imports no
// TS (BUILD-CONTRACT divergence #1). The runner derives the Pacific day key
// itself, so we hand it the real instant (`new Date()`), not `appToday()`.
//
// INTERNAL-ONLY: mirrors /internal/bonus/close-months. Any request carrying a
// `cf-connecting-ip` header (i.e. arriving via the public Cloudflare tunnel)
// gets a 404. The cron reaches it over the compose network. An optional
// `INTERNAL_CRON_TOKEN` adds a bearer check when set (defense in depth).

import { NextResponse } from 'next/server';
import { runDailyReportFire } from '@/lib/bonus/daily-report-runner';
import { runAlertDigestFire, type DigestOutcome } from '@/lib/audit/alert-digest';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  // Public-tunnel requests are not allowed to drive the cron.
  if (req.headers.get('cf-connecting-ip')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const requiredToken = process.env['INTERNAL_CRON_TOKEN'];
  if (requiredToken) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${requiredToken}`) {
      return new NextResponse('Not Found', { status: 404 });
    }
  }

  const now = new Date();
  const { outcomes } = await runDailyReportFire(now);

  const sent = outcomes.filter((o) => o.status === 'sent').length;
  log.info({ sites: outcomes.length, sent }, '[daily-report] run complete');

  // ADR-0043 D3 — the alert digest rides this same tick (no new container). It
  // runs for ALL sites independent of the production-report skip gates, so a
  // quiet/weekend day never suppresses an open-finding alert. Never throws
  // (each site is wrapped internally); a failure to run it must not 500 the cron.
  let alertOutcomes: DigestOutcome[] = [];
  try {
    ({ outcomes: alertOutcomes } = await runAlertDigestFire(now));
    const digestsSent = alertOutcomes.filter((o) => o.status === 'sent').length;
    log.info({ sites: alertOutcomes.length, digestsSent }, '[alert-digest] run complete');
  } catch (err) {
    log.error({ err }, '[alert-digest] fire threw (non-fatal to daily-report route)');
  }

  return NextResponse.json({ outcomes, alertOutcomes });
}
