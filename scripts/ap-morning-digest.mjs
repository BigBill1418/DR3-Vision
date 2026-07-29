#!/usr/bin/env node
// ADR-0066 §1.7 — AP morning-digest cron (thin Pacific scheduler).
//
// Architecture (mirrors scripts/board-pack-digest-cron.mjs): this .mjs imports
// NOTHING — no @prisma/client, no tsx, no TS. The prod image is
// `npm ci --omit=dev`, so a TS import would crash there. The fire time is fixed
// at 06:00 America/Los_Angeles. It computes the next 06:00 PT instant, sleeps
// until it, POSTs the internal, loopback-guarded route
// (`/api/internal/ap/morning-digest`) with the `INTERNAL_CRON_TOKEN` bearer when
// set, logs the outcome, and loops.
//
// ── WHY THIS IS NOT A UTC CRON ENTRY ────────────────────────────────────────
// The container clock is UTC. 06:00 PT is 13:00 UTC under PDT and 14:00 UTC
// under PST, so ANY fixed UTC cron expression is wrong for roughly half the year
// — it would silently drift an hour twice annually and, worse, land the "morning"
// digest at 05:00 PT in winter. There is no crontab here at all: the daemon
// re-derives the next 06:00 Pacific WALL-CLOCK instant on every iteration via
// `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`, so the DST rule
// comes from the tz database rather than from a hardcoded -7/-8 offset. Nothing
// needs to change at the March/November transitions.
//
// The route decides WHETHER to send: the weekday/fleet-holiday gate
// (`isBusinessDayNow`, the shared §1.5 clock) and the §1.7 empty-state
// suppression both live in the app, where the DB is. This daemon fires daily and
// a weekend fire is a clean, logged no-op.
//
// Long-running daemon under `unless-stopped`: if the loop ever throws past the
// per-iteration try/catch, the container restart brings us back to the same
// shape (compute next 06:00 PT → sleep → POST). The digest writes nothing, so a
// restart-induced re-fire is at worst a duplicate oversight email.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed daily fire: 06:00 America/Los_Angeles (ADR-0066 §1.7 — Bill's choice).
const FIRE_HOUR = 6;
const FIRE_MINUTE = 0;

let stopping = false;

function logTs(message) {
  console.log(`[ap-morning-digest ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helpers (copied from scripts/board-pack-digest-cron.mjs; stays
// plain JS so it runs from the runner stage without a TS compile step) ────

// Read the Pacific wall clock off a UTC instant — same technique as
// `src/lib/time.ts`, so "what time is it in Pacific" is DST-correct without
// hardcoding the -7/-8 offset.
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
 * strictly after `from`. DST-correct via the OFFSET-REPROBE technique shared by
 * every fleet daemon (stack-sweep 2026-07-10, pinned by
 * `src/__tests__/cron-dst-schedule.test.ts`): resolve the target Pacific wall
 * time on each candidate Pacific calendar day and convert to a true UTC instant
 * using the offset in effect ON THAT DAY.
 *
 * The naive "delta seconds-of-day added to `from`" version assumed every Pacific
 * day is 86400s and so misfired across DST: it DOUBLE-FIRED on fall-back (the
 * 25h day — it landed 1h early, then the loop recomputed and fired again at the
 * real wall clock) and fired 1h LATE on spring-forward (the 23h day). Anchoring
 * to the calendar day + that day's offset lands exactly on `hour:minute` PT
 * every day of the year.
 */
function nextFireInstantAt(from, hour, minute) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    // Re-probe the offset AT the target instant so a DST jump on the target day
    // is handled (that morning's offset may differ from `from`'s offset).
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000); // defensive (should never hit)
}

// ── POST the internal route ──────────────────────────────────────────

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded morning-digest route.
 * Resolves on success; throws on transport / redirect / non-200 so the caller's
 * try/catch logs it.
 *
 * `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if
 * the auth middleware ever lost the `/api/internal/ap/` exemption and 307'd this
 * POST to /login, fetch's default redirect-following would turn that into the
 * login page's 200 and the tick would "succeed" while sending nothing. A
 * redirect is ALWAYS a failure here; only a direct 200 from the route counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/ap/morning-digest`, {
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
 * One scheduler iteration: sleep until the next 06:00 PT instant, then POST the
 * route. Per-iteration try/catch (in `main`) so a transient HTTP error logs and
 * retries next tick.
 */
async function tick() {
  const now = new Date();
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(
    `next AP morning-digest tick at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`,
  );
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`tick complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs(
    'daemon starting — AP morning digest anchored to 06:00 America/Los_Angeles (weekdays only)',
  );

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
    console.error('ap-morning-digest: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, runFireOnce, truncateBody };
