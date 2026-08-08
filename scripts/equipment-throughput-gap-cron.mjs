#!/usr/bin/env node
// ADR-0087 — Terex throughput-gap watchdog cron (thin Pacific scheduler).
//
// Architecture (mirrors scripts/survey-reminder-cron.mjs verbatim): this .mjs
// imports NOTHING — no @prisma/client, no tsx, no TS. It computes the next
// 08:30 America/Los_Angeles instant (DST-correct via Intl formatToParts), sleeps
// until it, POSTs the internal, loopback-guarded route
// (`/api/internal/equipment/throughput-gap`) with the `INTERNAL_CRON_TOKEN`
// bearer when set, logs the outcome, and loops.
//
// WHY 08:30 PT. The nudge is about YESTERDAY, and the only thing its reader can
// actually do today is enter today's numbers — so it has to arrive before the
// day gets away from them, and after they are on site. 08:30 also deliberately
// does NOT collide with the 09:00 PT survey-reminder tick (one app process, no
// reason to make two scans contend) and sits ten hours clear of the 18:00 PT
// daily-report tick that carries the alert digest, so the two staff mails never
// arrive as a pair and get skimmed as one.
//
// The route does all the real work compiled inside the Next app via
// `runThroughputGapScan`. It is idempotent at the DATABASE level — the
// `equipment_throughput_gap_alerts` (site, gap_date) unique — so a slightly
// early/late POST, a container restart that re-fires, or a hand-run curl can
// never double-send. A weekend fire is a clean no-op (the scan skips itself).
//
// Long-running daemon under `unless-stopped`: if the loop ever throws past the
// per-iteration try/catch, the container restart brings us back to the same
// shape (compute next 08:30 PT → sleep → POST).

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed daily fire: 08:30 America/Los_Angeles (see the WHY 08:30 note above).
const FIRE_HOUR = 8;
const FIRE_MINUTE = 30;

let stopping = false;

function logTs(message) {
  console.log(`[throughput-gap-cron ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helpers ─────────────────────────────────────────────────
//
// Re-derived here (not imported from `@/lib/time`) because this wrapper stays
// plain JS and runs from the runner stage without a TS compile step — the same
// trade every other cron daemon in scripts/ makes, for the same reason.

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
 * strictly after `from`. DST-correct via the OFFSET-REPROBE technique ported
 * from `scripts/survey-reminder-cron.mjs` (originally `bonus-period-close.mjs`):
 * resolve the target Pacific wall time on each candidate Pacific calendar day
 * and convert to a true UTC instant using the offset in effect ON THAT DAY.
 *
 * A "delta seconds-of-day added to `from`" version assumes every Pacific day is
 * 86400s and misfires across DST — DOUBLE-FIRING on fall-back (the 25h day) and
 * firing an hour late on spring-forward. Anchoring to the calendar day + that
 * day's offset lands exactly on `hour:minute` PT every day of the year.
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
 * Drive one fire: POST the internal, loopback-guarded scan route. Resolves on
 * success; throws on transport / redirect / non-200 so the caller's try/catch
 * logs it.
 *
 * `redirect: 'manual'` is load-bearing, and more so here than almost anywhere.
 * On 2026-07-03 the auth middleware was missing the /api/internal/survey/
 * exemption and 307'd that POST to /login — fetch's default redirect-following
 * turned the login page's 200 into an apparent success while the tick sent
 * nothing. For a WATCHDOG that outcome is uniquely bad: the ledger stays empty,
 * and an empty ledger reads as "no gaps found". A redirect is ALWAYS a failure
 * here; only a direct 200 from the route counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/equipment/throughput-gap`, {
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
 * One scheduler iteration: sleep until the next 08:30 PT instant, then POST.
 * The daemon deliberately fires on weekend mornings too — the SCAN decides that
 * a weekend is a no-op, so the calendar rule lives in exactly one place (the TS
 * module, which is the one that is tested) rather than being duplicated into a
 * plain-JS daemon that nothing exercises.
 */
async function tick() {
  const now = new Date();
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(`next gap scan at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`);
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`scan complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — throughput-gap scan anchored to 08:30 America/Los_Angeles');

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logTs(`scan failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
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
    console.error('equipment-throughput-gap-cron: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, runFireOnce, truncateBody };
