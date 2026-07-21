#!/usr/bin/env node
// Bonus signature-escalation cron (ADR-0019.1 §3/§4/§6, T-205 + T-206).
//
// Mirrors `scripts/bonus-period-close.mjs`: a LONG-RUNNING daemon (single
// process, single `unless-stopped` restart policy) that is a THIN, Pacific-aware
// SCHEDULER. The orchestration (period queries, ntfy publishes, the auto-override
// through the state machine, PDF + M365 side-effects, the actor-availability
// guard) lives in TypeScript behind the internal route
// `/api/internal/bonus/escalation-check?tier=<t1|t2|t3|t4>` (see
// `src/lib/bonus/escalation.ts`, unit-tested). This wrapper only decides WHEN to
// fire each tier and POSTs the route — exactly the split T-204 uses, so the
// state machine is never re-implemented in plain `.mjs`.
//
// Four daily fires (Pacific wall clock — ADR-0019.1 §3 timeline, 2026-07-07
// amendment: the close now fires 07:00 PT on the payroll day, so t1 moved from
// 06:00 — which now predates the close — to 07:10, a post-close nudge):
//   07:10 PT → tier t1  (low-urgency "still unsigned" post-close nudge)
//   07:30 PT → tier t2  (urgent ntfy + override-authorized humans in the body)
//   08:30 PT → tier t3  (AUTO-OVERRIDE: system-sign unsigned slots, fire PDF+mail)
//   09:00 PT → tier t4  (T-206 payroll-deadline-missed ntfy if not yet `paid`)
//
// Schedule note (same shape as period-close): the daemon fires DAILY at each
// time. ADR-0019.1's escalation is "every other Tuesday", but cron/this loop
// can't express that cleanly and the route keys off SEEDED `period_end ==
// appToday() - 1 day` (Pacific) anyway. On any morning that is NOT the day after
// a period-end Monday, no period matches the yesterday's-close window, so the
// fire is a clean no-op. Deriving the next fire instant from the Pacific wall
// clock each cycle keeps it correct across the Mar/Nov DST shifts.
//
// Idempotent: t1/t2/t4 are fingerprinted+cooled in the ntfy helper; t3's
// auto-override goes through `recordSignature`, which rejects an already-signed
// slot (a slot signed manually by 08:25, or a re-POST after a restart, is NOT
// re-overridden). A second fire of any tier on the same day is safe.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

// ── Bounded in-window retry (audit P1-4) ────────────────────────────
// A tier fire that fails (transport error / redirect / non-200 — usually the app
// being down) is NOT "done until the next tier" any more. We retry it a bounded
// number of times, spaced within the tier's own window, inside the same daemon
// run. 3 attempts × 15min ≈ 30min covers the t3→t4 gap so the 08:30 auto-override
// gets several shots before the 09:00 PT payroll deadline. No new infra: the
// retry runs off the daemon's own timers, and the NEXT tier is armed immediately
// (see scheduleNext) so retries never delay a later tier's wall-clock fire.
const MAX_TIER_ATTEMPTS = 3;
const RETRY_SPACING_MS = 15 * 60 * 1000;

// ── Daemon-side, app-INDEPENDENT page on total fire failure (audit P1-4) ──
// The tier fires go THROUGH the app (POST /api/internal/...). If the app is down,
// every tier fails — including t4, the "payroll deadline missed" backstop, which
// would otherwise route its page through the same dead app. So when a tier
// exhausts its retries the daemon itself publishes DIRECTLY to ntfy (never
// touching the app), mirroring the primary→fallback helper in
// `scripts/bonus-eod-check.mjs`.
const NTFY_PRIMARY_BASE = process.env['NTFY_BASE_URL']?.trim() || 'https://ntfy.barnardhq.com';
const NTFY_FALLBACK_BASE = 'https://ntfy.sh';
const NTFY_TOPIC = process.env['NTFY_TOPIC_SYSTEM']?.trim() || 'dr3-vision-system';
const NTFY_FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
const NTFY_CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const NTFY_TIMEOUT_MS = 5_000;

// ADR-0037 severity: a failed t3 (auto-override + payroll PDF) or t4 (deadline
// backstop) is an imminent payroll miss → urgent; a failed t1/t2 reminder is a
// degraded self-monitor → high.
const TIER_FAILURE_PRIORITY = { t1: 'high', t2: 'high', t3: 'urgent', t4: 'urgent' };

// The four fire times (Pacific wall clock) → tier. Order does not matter; the
// scheduler always picks the soonest upcoming one.
const FIRES = [
  { hour: 7, minute: 10, tier: 't1' },
  { hour: 7, minute: 30, tier: 't2' },
  { hour: 8, minute: 30, tier: 't3' },
  { hour: 9, minute: 0, tier: 't4' },
];

// Parts formatter to read the Pacific wall clock off a UTC instant — same
// technique as `src/lib/time.ts` and `scripts/bonus-period-close.mjs`, so "what
// time is it in Pacific" is DST-correct without hardcoding -7/-8. Re-derived here
// (rather than importing `@/lib/time`) because this wrapper stays JavaScript and
// runs from the runner stage without a TS compile step.
const PACIFIC_TZ = 'America/Los_Angeles';
const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Pacific calendar date (YYYY-MM-DD) for the daemon-side fire-failure dedup id.
const PACIFIC_ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

let stopping = false;

function logTs(message) {
  console.log(`[bonus-escalation-check ${new Date().toISOString()}] ${message}`);
}

/** The Pacific wall-clock parts (numbers) for a UTC instant. */
function pacificParts(at) {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Signed offset (ms) such that `utc = pacificWallClockAsUTC - offset`. */
function pacificOffsetMs(at) {
  const p = pacificParts(at);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - at.getTime();
}

/**
 * The next UTC instant at which the Pacific wall clock reads `hour:minute:00`,
 * strictly after `from`. DST-correct (re-probes the offset on the target day).
 */
function msUntilPacificTime(hour, minute, from) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    const delta = fireUtc.getTime() - from.getTime();
    if (delta > 1_000) return delta;
  }
  return 24 * 60 * 60 * 1000; // defensive fallback (should never hit)
}

/**
 * The soonest upcoming fire across all four tier times. Returns `{ delay, tier }`
 * for the next one strictly after `from`.
 */
export function nextEscalationFire(from = new Date()) {
  let best = null;
  for (const f of FIRES) {
    const delay = msUntilPacificTime(f.hour, f.minute, from);
    if (best === null || delay < best.delay) best = { delay, tier: f.tier };
  }
  return best;
}

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * POST the internal, loopback-guarded escalation route for one tier. Resolves on
 * success; throws on transport / redirect / non-200 so the caller's try/catch
 * logs it.
 *
 * `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if
 * the /api/internal/bonus/ public-paths exemption were ever missing, the auth
 * middleware would 307 this POST to /login and fetch's default redirect-follow
 * would turn the login page's 200 into a "successful" tier run that escalates
 * nothing. A redirect is ALWAYS a failure here; only a direct 200 counts.
 */
async function runTierOnce(tier) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/escalation-check?tier=${tier}`, {
    method: 'POST',
    headers,
    redirect: 'manual',
  });
  const text = await res.text();
  if (res.status !== 200) {
    const loc = res.headers.get('location');
    throw new Error(`HTTP ${res.status}${loc ? ` (redirect → ${loc})` : ''}: ${truncateBody(text)}`);
  }
  return truncateBody(text);
}

/** Resolve after `ms`. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a body to ntfy with an abort timeout, resolving to `ok`. Never throws —
 * a down/slow ntfy must not crash the daemon. Ported from `bonus-eod-check.mjs`.
 */
async function postWithTimeout(url, body, headers, timeoutMs = NTFY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish an app-INDEPENDENT page that a tier fire failed after all retries.
 * Goes straight to ntfy (primary → fallback), NOT through the app, so a down app
 * — which is exactly what fails the tier fires, including the t4 backstop — can
 * never swallow the alert. Fingerprinted per (tier, Pacific day) so a restart
 * re-fire the same day dedupes. Returns whether a publish succeeded.
 */
async function publishFireFailure(tier, now = new Date()) {
  const isoDate = PACIFIC_ISO_FMT.format(now);
  const priority = TIER_FAILURE_PRIORITY[tier] ?? 'high';
  const title = `[DR3-Vision] escalation tier ${tier} fire FAILED`.slice(0, 250);
  const detail =
    tier === 't3'
      ? 'Auto-override + payroll PDF did NOT run — sign manually before the 09:00 AM PT deadline.'
      : tier === 't4'
        ? 'The payroll-deadline backstop did NOT run — verify payroll delivery manually.'
        : 'Signature-reminder tier did not fire — check the app and bonus signatures.';
  const body =
    `The bonus escalation daemon could not reach the app to run tier ${tier} after ` +
    `${MAX_TIER_ATTEMPTS} attempts (${isoDate} PT). ${detail}`;
  const fingerprint = `bonus-escalation-fire-failed:${tier}:${isoDate}`;

  const baseHeaders = {
    Priority: priority,
    Click: NTFY_CLICK_URL,
    Tags: 'rotating_light,bonus,escalation',
    'X-Dedup-Id': fingerprint,
  };

  // This is a safety-critical, app-INDEPENDENT payroll page (P1-4). The primary
  // ntfy.barnardhq.com publish needs the bearer, so when the token is unset we
  // must NOT post unauthenticated to the primary — but we still fall through to
  // the tokenless, anonymous-publish ntfy.sh fallback topic rather than going
  // silent (a stronger contract than bonus-eod-check's no-op, deliberately, since
  // this alert flags a missed payroll deadline).
  const token = process.env['NTFY_PUBLISHER_TOKEN']?.trim();
  if (token) {
    const ok = await postWithTimeout(`${NTFY_PRIMARY_BASE}/${NTFY_TOPIC}`, body, {
      ...baseHeaders,
      'X-Title': title,
      Authorization: `Bearer ${token}`,
    });
    if (ok) {
      logTs(`published tier ${tier} fire-failure page to ${NTFY_TOPIC} (${fingerprint})`);
      return true;
    }
    logTs(`primary ntfy publish failed for tier ${tier} — trying ntfy.sh fallback (${fingerprint})`);
  } else {
    logTs(
      `NTFY_PUBLISHER_TOKEN unset — skipping primary, attempting tokenless ntfy.sh fallback for tier ${tier} (${fingerprint})`,
    );
  }
  const fbOk = await postWithTimeout(`${NTFY_FALLBACK_BASE}/${NTFY_FALLBACK_TOPIC}`, body, {
    ...baseHeaders,
    'X-Title': `[FALLBACK] ${title}`.slice(0, 250),
  });
  logTs(
    fbOk
      ? `published tier ${tier} fire-failure page to FALLBACK topic (${fingerprint})`
      : `tier ${tier} fire-failure page FAILED (primary+fallback)`,
  );
  return fbOk;
}

/**
 * Fire one tier with bounded in-window retry. On success, returns early. On the
 * final failure, publishes the app-independent fire-failure page. Deps are
 * injectable so the retry/backstop logic is unit-testable without real waits or
 * real ntfy/app calls.
 */
async function fireTierWithRetry(tier, deps = {}) {
  const {
    runTier = runTierOnce,
    publishFailure = publishFireFailure,
    wait = sleep,
    maxAttempts = MAX_TIER_ATTEMPTS,
    spacingMs = RETRY_SPACING_MS,
  } = deps;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await runTier(tier);
      logTs(`tier ${tier} run complete (attempt ${attempt}/${maxAttempts}): ${text}`);
      return { ok: true, attempts: attempt };
    } catch (err) {
      logTs(`tier ${tier} attempt ${attempt}/${maxAttempts} failed: ${err?.message ?? err}`);
      if (attempt < maxAttempts) await wait(spacingMs);
    }
  }
  logTs(`tier ${tier} exhausted ${maxAttempts} attempts — publishing daemon-side page`);
  const paged = await publishFailure(tier);
  return { ok: false, attempts: maxAttempts, paged };
}

function scheduleNext() {
  if (stopping) return;
  const next = nextEscalationFire();
  const fireAt = new Date(Date.now() + next.delay).toISOString();
  logTs(
    `next escalation fire (${next.tier}) at ${fireAt} (in ${(next.delay / 1000 / 60).toFixed(1)}min)`,
  );
  setTimeout(() => {
    if (stopping) return;
    // Arm the FOLLOWING tier immediately. `nextEscalationFire()` excludes the
    // instant we just hit (its delta guard is >1s), so this schedules the next
    // distinct tier — never a re-fire of this one. Doing it up-front means the
    // bounded retry below (which can run ~30min) never pushes a later tier past
    // its wall-clock time.
    scheduleNext();
    // Fire this tier with retry + app-independent backstop page, in the
    // background relative to the scheduler.
    void fireTierWithRetry(next.tier);
  }, next.delay); // NOT .unref() — this timer must keep the daemon alive
}

function setupShutdown() {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { runTierOnce, truncateBody, fireTierWithRetry, publishFireFailure };

// Only start the daemon when run as the entrypoint — keeps the module importable
// (for the schedule-helper test) without spawning timers.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  setupShutdown();
  logTs('cron host started — escalation tiers anchored to 07:10/07:30/08:30/09:00 America/Los_Angeles');
  scheduleNext();
}
