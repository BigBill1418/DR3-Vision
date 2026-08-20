// ADR-0122 — the page for an operator standing at a truck with nothing to tap.
//
// ## Why this one alert breaks rule #5's letter, and keeps its spirit
//
// CLAUDE.md hard rule #5: ntfy carries SYSTEM-level events only; operational
// events — rejections, long unloads, SLA breaches, PIN lockouts — are in-app
// signals and never reach Bill's phone. ADR-0088 D4 applied that rule to a very
// similar-sounding condition (a manager who has not typed a number) and was
// right to: that is a fact about people and process.
//
// `no_live_controls` is the other kind. It is not a report that the floor is
// behind; it is a report that THE APPLICATION RENDERED A SCREEN WITH NO NEXT
// ACTION. Nobody on the floor can clear it, no amount of working harder resolves
// it, and it does not appear in any operational metric — on 2026-08-20 every
// monitor stayed green for 90 minutes while three operators took the same load
// over in turn. A defect that only manifests as an ABSENCE of requests is
// invisible to every system-health check the fleet owns, which is precisely what
// makes it a system event.
//
// ADR-0121 §Follow-ups states the grading directly: topic `dr3-vision-floor`,
// priority `high`, 15-minute cooldown, tier-1 click. This module implements that
// and nothing more.
//
// ## ADR-0037's five-question gate, answered
//
// 1. Actionable in 5 minutes? Yes — the click URL is the trapped load, and the
//    operator can be told to re-open it or the load can be worked from another
//    iPad. On 2026-08-20 the gap between the trap closing and Bill hearing about
//    it was sixteen minutes and a phone call.
// 2. Customer-visible? A load that cannot leave `arrived` is a truck on the dock
//    and a delivery that does not reach MyMRC. Yes.
// 3. Self-heal first? There is nothing to heal. The dead end IS the terminal
//    state; a retry renders the same dead screen, which is what a hard refresh
//    proved on the day.
// 4. Deduped against root cause? Fingerprint is (load, stage) — one page per
//    trapped load per stage per 15 minutes, no matter how many operators take it
//    over or how many times the page is re-opened.
// 5. Useful destination? Tier-1: the load itself.
//
// `high`, not `urgent`: it is one truck, not the fleet. Under ADR-0037 quiet
// hours (22:00–07:00 PT) a `high` buffers to the 07:00 digest, which is the right
// answer — there is nobody on the dock at 3 a.m. to be trapped.
//
// ## What this module deliberately does NOT do
//
// It does not decide whether a screen is dead — `stage-liveness.tsx` does, in the
// browser, from the real disable states. Splitting the decision from the delivery
// is the ADR-0019.5 lesson: a publisher that also judges is a publisher that can
// report an attempt as a success.

import { publishNtfy, type PublishNtfyResult } from '@/lib/ntfy';

/** ADR-0121 §Follow-ups. A NEW topic — see the ADR for the subscription caveat. */
const FLOOR_TOPIC = 'dr3-vision-floor';

/** ADR-0037 §3 — one page per trapped (load, stage) per 15 minutes. */
const FLOOR_COOLDOWN_MS = 15 * 60 * 1000;

/** ADR-0036 tier-1: the specific record page, not a dashboard. */
const APP_BASE = 'https://dr3-vision.svdp.us';

export interface StageDeadEndAlertArgs {
  siteCode: string;
  loadId: string;
  /** Which of the seven stages. Free string here; the route validates the union. */
  stage: string;
  /** control id → why it was dark. Rendered into the body, never into a header. */
  disableReasons: Readonly<Record<string, string>>;
}

/**
 * Page Bill that a stage rendered with zero live controls.
 *
 * Never throws — `publishNtfy` swallows every transport failure and logs a
 * structured drop line with the reason. The caller is a telemetry endpoint that
 * must answer 204 regardless.
 */
export async function publishStageDeadEndAlert(
  args: StageDeadEndAlertArgs,
): Promise<PublishNtfyResult> {
  const reasons = Object.entries(args.disableReasons)
    .map(([control, reason]) => `${control}=${reason}`)
    .sort()
    .join(', ');

  return publishNtfy({
    topic: FLOOR_TOPIC,
    // ADR-0036 title contract. `publishNtfy` prefixes `[DR3-Vision]`, so writing
    // it here too would double it.
    title: `Operator trapped: ${args.stage} has zero live controls`,
    body: [
      `Site: ${args.siteCode}`,
      `Load: ${args.loadId}`,
      `Stage: ${args.stage}`,
      // The first question anyone asks. Answering it in the page means the
      // triage starts from a fact rather than from a reproduction attempt.
      `Every control dark: ${reasons || '(none reported)'}`,
    ].join('\n'),
    priority: 'high',
    tags: ['warning', 'floor', 'dr3-vision'],
    clickUrl: `${APP_BASE}/operator/${encodeURIComponent(args.siteCode)}/load/${encodeURIComponent(args.loadId)}`,
    // Per (load, stage). NOT per user: three operators taking the same trapped
    // load over in turn is one defect, and on 2026-08-20 that is exactly what
    // happened — a per-user fingerprint would have paged three times for it.
    fingerprint: `floor-dead-end:${args.loadId}:${args.stage}`,
    cooldownMs: FLOOR_COOLDOWN_MS,
  });
}

/** Exported for the suite, so the contract is asserted rather than restated. */
export const __alertContract = {
  topic: FLOOR_TOPIC,
  cooldownMs: FLOOR_COOLDOWN_MS,
  appBase: APP_BASE,
} as const;
