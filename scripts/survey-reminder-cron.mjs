#!/usr/bin/env node
// ADR-0036 — Survey daily-reminder cron (thin Pacific scheduler).
//
// Architecture (mirrors scripts/bonus-daily-report.mjs → the internal route):
// this .mjs imports NOTHING (no @prisma/client, no tsx, no TS) — the fire time
// is fixed at 09:00 America/Los_Angeles, so it is even simpler than the
// daily-report scheduler, which had to read per-site send times. It computes the
// next 09:00 PT instant (DST-correct via Intl formatToParts), sleeps until it,
// then POSTs the internal, loopback-guarded route
// (`/api/internal/survey/reminder-tick`) with the `INTERNAL_CRON_TOKEN` bearer
// when set, logs the outcome, and loops.
//
// The route does all the real work (candidate selection, the 20h daily gate,
// tiered copy, auto-close + ntfy) compiled inside the Next app via
// `runSurveyReminderTick`. It is idempotent: the 20h `last_reminder_at` DB gate
// means a slightly-early/late POST — or a container restart that re-fires — can
// never double-send, and a no-op fires cleanly when no campaign is open.
//
// Long-running daemon under `unless-stopped`: if the loop ever throws past the
// per-iteration try/catch, the container restart brings us back to the same
// shape (compute next 09:00 PT → sleep → POST).

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed daily fire: 09:00 America/Los_Angeles (ADR-0036).
const FIRE_HOUR = 9;
const FIRE_MINUTE = 0;

let stopping = false;

function logTs(message) {
  console.log(`[survey-reminder-cron ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helper (copied from scripts/bonus-daily-report.mjs; stays
// plain JS so it runs without a TS compile step) ─────────────────────────

// Read the Pacific wall clock off a UTC instant — same technique as
// `src/lib/time.ts` and `scripts/bonus-period-close.mjs`, so "what time is it in
// Pacific" is DST-correct without hardcoding the -7/-8 offset. Re-derived here
// (not imported from `@/lib/time`) because this wrapper stays plain JS and runs
// from the runner stage without a TS compile step.
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
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`,
 * strictly after `from`. DST-correct via the OFFSET-REPROBE technique ported from
 * `scripts/bonus-period-close.mjs` (`msUntilNext0700Pacific`): resolve the target
 * Pacific wall time on each candidate Pacific calendar day and convert to a true
 * UTC instant using the offset in effect ON THAT DAY.
 *
 * This replaces the earlier "delta seconds-of-day added to `from`" version, which
 * assumed every Pacific day is 86400s and so misfired across DST: it DOUBLE-FIRED
 * on fall-back (the 25h day — it landed 1h early, then the loop recomputed and
 * fired again at the real wall clock) and fired 1h LATE on spring-forward (the 23h
 * day). Anchoring to the calendar day + that day's offset lands exactly on
 * `hour:minute` PT every day of the year.
 */
function nextFireInstantAt(from, hour, minute) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    // Re-probe the offset AT the target instant so a DST jump on the target day is
    // handled (that morning's offset may differ from `from`'s offset).
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000); // defensive fallback (should never hit)
}

// ── POST the internal route ──────────────────────────────────────────

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded reminder-tick route.
 * Resolves on success; throws on transport / redirect / non-200 so the caller's
 * try/catch logs it.
 *
 * `redirect: 'manual'` is load-bearing: on 2026-07-03 the auth middleware was
 * missing the /api/internal/survey/ exemption and 307'd this POST to /login —
 * fetch's default redirect-following turned that into the login page's 200 and
 * the tick "succeeded" while sending nothing. A redirect is ALWAYS a failure
 * here; only a direct 200 from the route counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/survey/reminder-tick`, {
    method: 'POST',
    headers,
    redirect: 'manual',
  });
  const text = await res.text();
  if (res.status !== 200) {
    const loc = res.headers.get('location');
    throw new Error(
      `HTTP ${res.status}${loc ? ` (redirect → ${loc})` : ''}: ${truncateBody(text)}`,
    );
  }
  return truncateBody(text);
}

// ── Schedule ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One scheduler iteration: sleep until the next 09:00 PT instant, then POST the
 * route. Per-iteration try/catch (in `main`) so a transient HTTP error logs and
 * retries next tick.
 */
async function tick() {
  const now = new Date();
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(`next reminder tick at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`);
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`tick complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — survey reminders anchored to 09:00 America/Los_Angeles');

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logTs(`tick failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
      // Back off briefly so a hard-down dependency doesn't hot-loop.
      await sleep(30_000);
    }
  }
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
  main().catch((err) => {
    console.error('survey-reminder-cron: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, runFireOnce, truncateBody };
