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

  const { outcomes } = await runDailyReportFire(new Date());

  const sent = outcomes.filter((o) => o.status === 'sent').length;
  log.info({ sites: outcomes.length, sent }, '[daily-report] run complete');
  return NextResponse.json({ outcomes });
}
