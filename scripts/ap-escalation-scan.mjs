#!/usr/bin/env node
// ADR-0066 §1.5 — AP second-approval escalation scanner (thin hourly scheduler).
//
// Architecture (mirrors scripts/ap-approver-expiry-cron.mjs): this .mjs imports
// NOTHING (no @prisma/client, no tsx, no TS). It sleeps until the next :10 past
// the hour, POSTs the internal, loopback-guarded route
// (`/api/internal/ap/escalation-scan`) with the `INTERNAL_CRON_TOKEN` bearer when
// set, logs the outcome, and loops.
//
// The route does all the real work compiled inside the Next app via
// `runApEscalationScan`: read the open second-approval backlog, age each row on
// the WEEKDAY business clock, and — for anything past its pair's
// `fallback_after_hours` — stamp `escalated_at`/`escalated_to`, write an
// append-only audit row, and email the fallback approver. Escalation is ADDITIVE:
// the originally routed peer stays able to sign.
//
// ── WHY THE CADENCE NEEDS NO PACIFIC ARITHMETIC ─────────────────────────────
// Every sibling daemon here does DST-correct Pacific wall-clock math because it
// fires at a WALL-CLOCK TIME (00:05 PT, 20:00 PT, …). This one fires HOURLY, and
// an hour is an hour in every zone — a plain UTC "next :10" is DST-immune by
// construction, and inventing Pacific offset-reprobe logic for it would be
// ceremony that can only introduce a bug. The weekday/holiday clock that decides
// what actually escalates lives in `src/lib/ap/business-clock.ts`, inside the
// app, where it is unit-tested. The daemon is a metronome, nothing more.
//
// :10 past the hour, not :00 — the top of the hour is where every other fleet
// cron lands, and this scan wants the app unloaded, not queued behind them.
//
// `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if
// the public-paths exemption for /api/internal/ap/ were ever missing, the auth
// middleware would 307 this POST to /login and fetch's default redirect-follow
// would turn the login page's 200 into a "successful" no-op. A redirect is ALWAYS
// a failure here; only a direct 200 from the route counts.
//
// Idempotent: the scan claims each request conditionally on `escalated_at IS
// NULL`, so a re-fire, an overlapping tick, or a container restart mid-run can
// never double-escalate or double-notify.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

/** Minute past each hour at which the scan fires. */
const FIRE_MINUTE = 10;

let stopping = false;

function logTs(message) {
  console.log(`[ap-escalation-scan ${new Date().toISOString()}] ${message}`);
}

/**
 * The next UTC instant whose minute-of-hour is `minute` (seconds zeroed),
 * strictly after `from`. No timezone math: an hourly cadence is identical in
 * every zone, so this cannot drift across the Mar/Nov DST boundaries the
 * wall-clock daemons have to defend against.
 */
function nextHourlyFireInstant(from, minute) {
  const fire = new Date(from.getTime());
  fire.setUTCMinutes(minute, 0, 0);
  if (fire.getTime() <= from.getTime()) fire.setUTCHours(fire.getUTCHours() + 1);
  return fire;
}

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded scan route. Resolves on
 * success; throws on transport / redirect / non-200 so the caller's try/catch
 * logs it. A redirect is ALWAYS a failure; only a direct 200 counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/ap/escalation-scan`, {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  const now = new Date();
  const fire = nextHourlyFireInstant(now, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(
    `next escalation scan at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`,
  );
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`tick complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs(`daemon starting — AP escalation scan hourly at :${String(FIRE_MINUTE).padStart(2, '0')}`);

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      // The ROUTE pages dr3-vision-system when the scan itself fails, so this
      // path stays a log + backoff rather than a second alert channel.
      logTs(`tick failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
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
    console.error('ap-escalation-scan: fatal', err);
    process.exit(1);
  });
}

export { nextHourlyFireInstant, runFireOnce, truncateBody };
