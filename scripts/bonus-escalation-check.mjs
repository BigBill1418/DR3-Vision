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
// Four daily fires (Pacific wall clock — ADR-0019.1 §3 timeline):
//   06:00 PT → tier t1  (low-urgency "still unsigned" ntfy)
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

// The four fire times (Pacific wall clock) → tier. Order does not matter; the
// scheduler always picks the soonest upcoming one.
const FIRES = [
  { hour: 6, minute: 0, tier: 't1' },
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

/**
 * POST the internal, loopback-guarded escalation route for one tier. Resolves on
 * success; throws on transport / non-2xx so the caller's try/catch logs it.
 */
async function runTierOnce(tier) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/escalation-check?tier=${tier}`, {
    method: 'POST',
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return text;
}

function scheduleNext() {
  if (stopping) return;
  const next = nextEscalationFire();
  const fireAt = new Date(Date.now() + next.delay).toISOString();
  logTs(
    `next escalation fire (${next.tier}) at ${fireAt} (in ${(next.delay / 1000 / 60).toFixed(1)}min)`,
  );
  setTimeout(() => {
    runTierOnce(next.tier)
      .then((text) => logTs(`tier ${next.tier} run complete: ${text}`))
      .catch((err) =>
        logTs(`tier ${next.tier} run failed (non-fatal, retry next tick): ${err?.message ?? err}`),
      )
      .finally(scheduleNext);
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

// Only start the daemon when run as the entrypoint — keeps the module importable
// (for the schedule-helper test) without spawning timers.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  setupShutdown();
  logTs('cron host started — escalation tiers anchored to 06:00/07:30/08:30/09:00 America/Los_Angeles');
  scheduleNext();
}
