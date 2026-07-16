// Internal survey-reminder cron endpoint (ADR-0036).
//
// The thin Pacific-aware daemon `scripts/survey-reminder-cron.mjs` POSTs here
// once per day at 09:00 America/Los_Angeles. The real work (candidate selection,
// the 20h daily gate, tiered copy, auto-close + ntfy) runs compiled inside the
// Next app via `runSurveyReminderTick` — the daemon imports no TS.
//
// INTERNAL-ONLY: mirrors /api/internal/bonus/escalation-check verbatim. Any
// request carrying a `cf-connecting-ip` header (i.e. arriving via the public
// Cloudflare tunnel) gets a 404. The cron reaches it over the compose network.
// An optional `INTERNAL_CRON_TOKEN` adds a bearer check when set (defense in
// depth).

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { runSurveyReminderTick } from '@/lib/survey/reminders';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const summary = await runSurveyReminderTick();
  log.info(
    {
      campaigns: summary.campaigns,
      sent: summary.remindersSent,
      failed: summary.remindersFailed,
      skipped: summary.remindersSkipped,
      closed: summary.closed,
    },
    '[survey-reminder] tick complete',
  );
  return NextResponse.json(summary);
}
