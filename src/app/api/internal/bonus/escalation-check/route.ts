// Internal bonus-escalation cron endpoint (ADR-0019.1 §3/§4/§6, T-205 + T-206).
//
// Mirrors the period-close design (T-204): the thin Pacific-aware daemon
// `scripts/bonus-escalation-check.mjs` POSTs here at four Pacific wall-clock
// times every day (no-op on a non-Tuesday because nothing matches the
// "yesterday's-close" window), one tier per fire:
//
//   tier=t1  07:10 PT  low-urgency post-close nudge per still-unsigned slot
//                      (moved from 06:00 per the ADR-0019.1 2026-07-07
//                      amendment — the close now fires 07:00 PT, so t1 lands
//                      just after it)
//   tier=t2  07:30 PT  urgent ntfy per still-unsigned slot, body lists the
//                      override-authorized humans from the signature chain
//   tier=t3  08:30 PT  AUTO-OVERRIDE: system-sign each still-unsigned slot AS
//                      the chain's auto_override_actor (Bill), stamping
//                      `*_auto_override_at` + the ADR-0019.1 reason text; this
//                      runs through the SAME state-machine path as a manual
//                      override (signatures.recordSignature) and triggers the
//                      existing post-signature side-effects (PDF + M365). Before
//                      auto-signing, the configured actor MUST be a valid ACTIVE
//                      user — else an urgent ntfy fires and we DO NOT sign
//                      (better to miss with an explicit alert than fail silently
//                      — addendum risk-mitigation row).
//   tier=t4  09:00 PT  (T-206) urgent payroll-deadline-missed ntfy for any
//                      yesterday's-period row that has not reached `paid`.
//
// SCOPE — "yesterday's-close" periods (ADR-0019.1 §6): the close cron now fires
// 07:00 PT on the payroll day (the day after period_end) moving
// `draft -> pending_signatures`; the escalation tiers fire the SAME morning
// starting 07:10, so they examine periods whose `period_end` is the Pacific
// calendar day BEFORE today. We derive that key from `appToday()` (Pacific)
// minus one day so the run is deterministic and DST-safe. (This "yesterday"
// scoping is unchanged by the 2026-07-07 amendment — only the close's own fire
// time moved from 17:30-on-period_end to 07:00-on-payroll-day, which now aligns
// with the escalation window.)
//
// INTERNAL-ONLY: like /api/internal/bonus/close-months, any request carrying a
// `cf-connecting-ip` header (public Cloudflare tunnel) gets a 404. The cron
// reaches it over the compose network. An optional `INTERNAL_CRON_TOKEN` adds a
// bearer check when set (defense in depth).

import { NextResponse } from 'next/server';
import { guardInternalCron } from '@/lib/internal-auth';
import { prisma } from '@/lib/prisma';
import { runEscalationTier, type EscalationTier, isEscalationTier } from '@/lib/bonus/escalation';
import { log } from '@/lib/observability/logger';
import { appToday } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = guardInternalCron(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const tierParam = url.searchParams.get('tier');
  if (!isEscalationTier(tierParam)) {
    return NextResponse.json(
      { error: `invalid tier; expected one of t1|t2|t3|t4, got ${tierParam ?? 'null'}` },
      { status: 400 },
    );
  }
  const tier: EscalationTier = tierParam;

  // The escalation tiers fire the morning AFTER the Mon 17:30 PT close, so they
  // examine yesterday's-close periods. `appToday()` keys off the Pacific zone
  // (the fires land 06:00–09:00 PT, already past UTC midnight — a raw Date would
  // resolve to the wrong calendar day).
  const result = await runEscalationTier({ db: prisma, tier, now: appToday() });

  log.info(
    {
      tier,
      periods: result.periodsExamined,
      ntfy: result.ntfyPublished,
      autoSigned: result.autoSigned,
      deadlineMissed: result.deadlineMissed,
      actorUnavailable: result.actorUnavailable,
    },
    '[escalation-check] run complete',
  );
  return NextResponse.json(result);
}
