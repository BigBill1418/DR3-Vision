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

/**
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`,
 * strictly at/after `from`. DST-correct: the Intl formatter does the zone math.
 * If today's hh:mm PT has already passed, it rolls to tomorrow's.
 */
function nextFireInstantAt(from, hour, minute) {
  const FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(FMT.formatToParts(from).map((p) => [p.type, p.value]));
  const currentSecondsOfDay =
    Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const fireSecondsOfDay = hour * 3600 + minute * 60;
  let deltaSec;
  if (currentSecondsOfDay < fireSecondsOfDay) {
    deltaSec = fireSecondsOfDay - currentSecondsOfDay;
  } else {
    deltaSec = 86400 - currentSecondsOfDay + fireSecondsOfDay;
  }
  return new Date(from.getTime() + deltaSec * 1000);
}

// ── POST the internal route ──────────────────────────────────────────

/**
 * Drive one fire: POST the internal, loopback-guarded reminder-tick route.
 * Resolves on success; throws on transport / non-2xx so the caller's try/catch
 * logs it.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/survey/reminder-tick`, {
    method: 'POST',
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return text;
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

export { nextFireInstantAt };
