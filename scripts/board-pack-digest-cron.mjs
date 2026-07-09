#!/usr/bin/env node
// ADR-0045 §3 addendum (planning rollup 2026-07-08 §1.8) — board-pack digest cron
// (thin Pacific scheduler).
//
// Architecture (mirrors scripts/survey-reminder-cron.mjs): this .mjs imports
// NOTHING (no @prisma/client, no tsx, no TS). The fire time is fixed at 07:00
// America/Los_Angeles. It computes the next 07:00 PT instant (DST-correct via
// Intl formatToParts), sleeps until it, then POSTs the internal, loopback-guarded
// route (`/api/internal/board-pack/send`) with the `INTERNAL_CRON_TOKEN` bearer
// when set, logs the outcome, and loops.
//
// The route (via `sendBoardPackDigest`) does all the real work: it decides
// whether today is a board-pack day (2nd Wednesday OR the preceding Monday) and
// whether this period was already sent. The cron just fires DAILY; the route
// filters. It is idempotent — the `board_pack_send_log` period_start unique gate
// means a slightly-early/late POST, the double-trigger, or a container restart
// that re-fires can never double-send, and a no-op fires cleanly off-cadence.
//
// Long-running daemon under `unless-stopped`: if the loop ever throws past the
// per-iteration try/catch, the container restart brings us back to the same
// shape (compute next 07:00 PT → sleep → POST).

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed daily fire: 07:00 America/Los_Angeles (handoff §1.8).
const FIRE_HOUR = 7;
const FIRE_MINUTE = 0;

let stopping = false;

function logTs(message) {
  console.log(`[board-pack-digest-cron ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helper (copied from scripts/survey-reminder-cron.mjs; stays
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

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded board-pack send route.
 * Resolves on success; throws on transport / redirect / non-200 so the caller's
 * try/catch logs it.
 *
 * `redirect: 'manual'` is load-bearing: if the auth middleware ever lost the
 * /api/internal/board-pack/ exemption and 307'd this POST to /login, fetch's
 * default redirect-following would turn that into the login page's 200 and the
 * tick would "succeed" while sending nothing. A redirect is ALWAYS a failure
 * here; only a direct 200 from the route counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/board-pack/send`, {
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
 * One scheduler iteration: sleep until the next 07:00 PT instant, then POST the
 * route. Per-iteration try/catch (in `main`) so a transient HTTP error logs and
 * retries next tick.
 */
async function tick() {
  const now = new Date();
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(`next board-pack tick at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`);
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`tick complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — board-pack digest anchored to 07:00 America/Los_Angeles');

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
    console.error('board-pack-digest-cron: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, runFireOnce, truncateBody };
