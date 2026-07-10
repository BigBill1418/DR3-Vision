#!/usr/bin/env node
// ADR-0040 D4 — Weekly EIA fuel-price fetch cron (thin Pacific scheduler).
//
// Architecture (mirrors scripts/survey-reminder-cron.mjs): this .mjs imports NOTHING
// (no @prisma/client, no tsx, no TS). It computes the next Tuesday 06:00
// America/Los_Angeles instant (DST-correct via Intl formatToParts), sleeps until it,
// then POSTs the internal, loopback-guarded route (`/api/internal/billing/fuel-fetch`)
// with the `INTERNAL_CRON_TOKEN` bearer when set, logs the outcome, and loops.
//
// The route does all the real work (EIA fetch + `fuel_prices` upsert + fingerprinted
// failure paging) compiled inside the Next app via `runFuelFetchTick`. It is
// idempotent (upsert-by-week, never overwrites a manual entry), so a slightly-early/
// late POST — or a container restart that re-fires — is safe. Success is silent; a
// fetch failure pages `dr3-vision-system` (fingerprint `fuel-fetch-failed`).
//
// Long-running daemon under `unless-stopped`: if the loop ever throws past the
// per-iteration try/catch, the container restart brings us back to the same shape.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed weekly fire: Tuesday 06:00 America/Los_Angeles (ADR-0040 D4). EIA posts the
// prior week's West-Coast retail diesel price on Mondays; Tuesday morning is safely
// after publication.
const FIRE_WEEKDAY = 2; // 0=Sun … 2=Tue … 6=Sat
const FIRE_HOUR = 6;
const FIRE_MINUTE = 0;

let stopping = false;

function logTs(message) {
  console.log(`[fuel-price-cron ${new Date().toISOString()}] ${message}`);
}

// ── Pacific weekly fire helper (DST-correct via Intl) ────────────────────

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
 * Next UTC instant at which the Pacific wall clock reads `weekday hour:minute:00`,
 * strictly after `from`. DST-correct via the OFFSET-REPROBE technique ported from
 * `scripts/bonus-period-close.mjs` (`msUntilNext0700Pacific`), adapted to a WEEKLY
 * cadence: walk forward one Pacific calendar day at a time until we hit the target
 * weekday, then resolve that day's `hour:minute` PT to a true UTC instant using the
 * offset in effect ON THAT DAY. `weekday` is 0=Sun … 6=Sat (day-of-week is a
 * property of the calendar date, so it is derived zone-free from the Pacific date).
 *
 * This replaces the earlier "delta seconds-of-day + dayDelta*86400 added to `from`"
 * version, which assumed every Pacific day is 86400s and so misfired across DST —
 * on a week spanning a fall-back it fired 1h early (and could double-fire) and
 * across a spring-forward it fired 1h late.
 */
function nextWeeklyFireInstant(from, weekday, hour, minute) {
  for (let addDays = 0; addDays <= 8; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    // Day-of-week of the candidate Pacific calendar day (zone-free once we have
    // the y/m/d — the UTC-midnight of that date has the same weekday).
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    if (dow !== weekday) continue;
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000); // defensive fallback (should never hit)
}

// ── POST the internal route ──────────────────────────────────────────

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded fuel-fetch route. Resolves on
 * success; throws on transport / redirect / non-200 so the caller's try/catch logs it.
 *
 * `redirect: 'manual'` is load-bearing (ADR-0036 lesson): a middleware misconfig that
 * 307s this POST to /login would otherwise be followed to a 200 HTML page and read as
 * success. A redirect is ALWAYS a failure here; only a direct 200 counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/billing/fuel-fetch`, {
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

// ── Schedule ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  const now = new Date();
  const fire = nextWeeklyFireInstant(now, FIRE_WEEKDAY, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(`next fuel fetch at ${fire.toISOString()} (in ${(sleepMs / 1000 / 3600).toFixed(1)}h)`);
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`fetch complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — fuel-price fetch anchored to Tue 06:00 America/Los_Angeles');

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logTs(`tick failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
      // Back off briefly so a hard-down dependency doesn't hot-loop.
      await sleep(60_000);
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
    console.error('fuel-price-cron: fatal', err);
    process.exit(1);
  });
}

export { nextWeeklyFireInstant, runFireOnce, truncateBody };
