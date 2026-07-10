#!/usr/bin/env node
// Bonus period-close cron (ADR-0019.1 §3/§6, T-204). Replaces the monthly
// `scripts/bonus-month-close.mjs`.
//
// Cadence (ADR-0019.1 §3 + 2026-07-07 amendment): the close fires at 07:00 PT on
// the PAYROLL DAY — the day AFTER `period_end` — not 17:30 on period_end itself.
// The schedule is "daily 07:00 PT", not "every other Tuesday", because cron
// cannot express "every other Tuesday" cleanly and the underlying decision is
// keyed off the SEEDED `bonus_pay_periods.period_end = appToday() - 1 day`
// (Pacific) anyway. On any day that is NOT a payroll day, nothing matches
// `state = 'draft' AND period_end = yesterday`, so the fire is a clean no-op.
// This is the daily-tick + Pacific-aware date check that ADR-0019.1 §6 /
// "Alternatives considered" explicitly prefers over a real cron (DST-robust).
//
// Shape: a LONG-RUNNING daemon (mirrors `scripts/mymrc-cron.mjs`), single
// process / single restart policy (`unless-stopped` in compose). It sleeps
// until the next 07:00 America/Los_Angeles instant — recomputed each cycle from
// the Pacific wall clock so it stays correct across the Mar/Nov DST shifts — and
// on each fire drives the close. If the loop ever throws past the per-fire
// try/catch, the container restart brings us back to the same shape (compute
// next 07:00 PT → sleep → fire).
//
// Why POST the internal Next route rather than import the state machine here:
// the period-close ORCHESTRATION is the transition (`closePayPeriodsDueForSignature`)
// PLUS the signature-request email (`notifyPendingSigner`) per newly-closed
// period, and that orchestration lives behind `/api/internal/bonus/close-months`
// (it imports the bonus tx layer + the email path; it is unit-tested in
// `close-months.route.test.ts`). The route already passes `appToday()` (Pacific)
// as `now`, so the close decision is Pacific-aware via `@/lib/time` — not a raw
// `Date`. Re-implementing that orchestration in plain `.mjs` would duplicate
// untested logic and re-create the state machine outside TypeScript, which
// ADR-0019 deliberately avoids. The .mjs stays a thin Pacific-aware scheduler.
//
// Idempotent: the route's `closePayPeriodsDueForSignature` only matches
// `state = 'draft'`, so a second fire on the same day (or a container restart
// that re-fires) does not double-transition — once a period is in
// `pending_signatures` it no longer matches.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

// Close fire time, Pacific wall clock. ADR-0019.1 (2026-07-07 amendment):
// 07:00 PT on the payroll day (the day after period_end).
const FIRE_HOUR_PT = 7;
const FIRE_MINUTE_PT = 0;

// Parts formatter to read the Pacific wall clock off a UTC instant — same
// technique as `src/lib/time.ts` (`PACIFIC_PARTS_FMT` / `pacificOffsetMs`), so
// "what time is it in Pacific" is DST-correct without hardcoding the -7/-8
// offset. We deliberately re-derive it here (rather than import `@/lib/time`)
// because this wrapper stays JavaScript and runs from the runner stage without
// a TS compile step — exactly like `scripts/mymrc-cron.mjs`.
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

let stopping = false;

function logTs(message) {
  console.log(`[bonus-period-close ${new Date().toISOString()}] ${message}`);
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
 * The next UTC instant at which the Pacific wall clock reads
 * `FIRE_HOUR_PT:FIRE_MINUTE_PT:00`, strictly after `from`. DST-correct: it
 * resolves the target Pacific wall time on the candidate Pacific calendar day,
 * converting to UTC via the offset in effect that day. If today's 07:00 PT has
 * already passed, it rolls to tomorrow's 07:00 PT.
 */
export function msUntilNext0700Pacific(from = new Date()) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    // Pacific wall clock reinterpreted as UTC for the target time on day p.
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, FIRE_HOUR_PT, FIRE_MINUTE_PT, 0);
    // Convert that Pacific wall time to a true UTC instant using the offset in
    // effect AT that instant (re-probe so a DST jump on the target day is right).
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    const delta = fireUtc.getTime() - from.getTime();
    if (delta > 1_000) return delta;
  }
  // Defensive fallback (should never hit): 24h.
  return 24 * 60 * 60 * 1000;
}

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one close: POST the internal, loopback-guarded close route. The route
 * transitions every `draft` period whose `period_end == appToday() - 1 day`
 * (Pacific — the payroll day is the day after period_end) to
 * `pending_signatures` via the audited state machine and fires the
 * signature-request email per newly-closed period. Resolves on success; throws
 * on transport / redirect / non-200 so the caller's try/catch logs it.
 *
 * `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if
 * the /api/internal/bonus/ public-paths exemption were ever missing, the auth
 * middleware would 307 this POST to /login and fetch's default redirect-follow
 * would turn the login page's 200 into a "successful" close that transitions
 * nothing. A redirect is ALWAYS a failure here; only a direct 200 counts.
 */
async function runCloseOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/close-months`, {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded same-day retry (fixes: a single failed 07:00 tick permanently skipping
// the close). The daily schedule matches ONLY `period_end == yesterday`, so if the
// 07:00 POST fails and we simply "retry next tick", by tomorrow's 07:00 the just-
// ended period no longer matches yesterday and its close is silently skipped for
// good. Retrying WITHIN the same payroll day keeps the close keyed to the correct
// `period_end`. 6 attempts × 30 min ≈ a 07:00→09:30 window — long enough to ride
// out an app restart / brief DB blip, short enough to finish well before the next
// day's 07:00 fire.
const CLOSE_RETRY_DELAY_MS = 30 * 60 * 1000;
const CLOSE_MAX_ATTEMPTS = 6;

// WHY WE DO NOT WIDEN THE ROUTE MATCHER TO `period_end <= yesterday` (state-machine
// closePayPeriodsDueForSignature): it is NOT safe. `bonus_pay_periods.state`
// defaults to `draft` (prisma/schema.prisma) and `seedBonusPayPeriods`
// (prisma/seed.mjs) seeds ALL 26 periods/site/year — past AND future — as `draft`;
// only historical-CSV periods become `historical_imported` and only pre-cutover
// no-data periods become `skipped`. So onboarding a new site mid-year (or any fresh
// seed) legitimately leaves PAST periods `draft` with a past `period_end`. A
// `<= yesterday` matcher would mass-close every such back-period on the next tick
// AND fire a signature-request email per period — closing periods deliberately left
// alone. The exact `period_end == yesterday` match plus this same-day retry closes
// the actual gap (a transient 07:00 failure) without that blast radius. Residual
// risk: a FULL-day outage (daemon/app down 07:00→09:30) still skips that day's
// close; an operator must close it manually. Documented, not silently "fixed".

/**
 * Fire the 07:00 close, retrying on failure every 30 min up to CLOSE_MAX_ATTEMPTS
 * within the same payroll day. Never rejects — logs and returns so the caller can
 * re-arm for tomorrow's 07:00. Loud, explicit give-up on exhaustion.
 */
async function runCloseWithSameDayRetry() {
  for (let attempt = 1; attempt <= CLOSE_MAX_ATTEMPTS; attempt++) {
    if (stopping) return;
    try {
      const text = await runCloseOnce();
      logTs(`close run complete (attempt ${attempt}/${CLOSE_MAX_ATTEMPTS}): ${text}`);
      return;
    } catch (err) {
      if (attempt === CLOSE_MAX_ATTEMPTS) {
        logTs(
          `close run FAILED after ${CLOSE_MAX_ATTEMPTS} attempts — GIVING UP until tomorrow's ` +
            `07:00 PT. The period whose period_end was yesterday may be left in 'draft'; an ` +
            `operator must close it manually. Last error: ${err?.message ?? err}`,
        );
        return;
      }
      logTs(
        `close run failed (attempt ${attempt}/${CLOSE_MAX_ATTEMPTS}, retrying in ` +
          `${CLOSE_RETRY_DELAY_MS / 60000}min): ${err?.message ?? err}`,
      );
      await sleep(CLOSE_RETRY_DELAY_MS);
    }
  }
}

function scheduleNext() {
  if (stopping) return;
  const delay = msUntilNext0700Pacific();
  const fireAt = new Date(Date.now() + delay).toISOString();
  logTs(`next close fire at ${fireAt} (in ${(delay / 1000 / 60).toFixed(1)}min) — 07:00 PT`);
  setTimeout(() => {
    runCloseWithSameDayRetry().finally(scheduleNext);
  }, delay); // NOT .unref() — this timer must keep the daemon alive
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

export { runCloseOnce, truncateBody };

// Only start the daemon when run as the entrypoint — keeps the module
// importable (for a smoke/helper test) without spawning timers.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  setupShutdown();
  logTs('cron host started — daily close anchored to 07:00 America/Los_Angeles (payroll day)');
  scheduleNext();
}
