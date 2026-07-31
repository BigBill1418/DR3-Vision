#!/usr/bin/env node
// ADR-0071 — processor production quota digest cron (thin Pacific scheduler).
//
// Architecture (mirrors scripts/board-pack-digest-cron.mjs): this .mjs imports
// NOTHING — no @prisma/client, no tsx, no TypeScript. It computes the next
// 06:00 PT instant (DST-correct via Intl formatToParts), sleeps until it, POSTs
// the internal loopback-guarded route, logs, and loops.
//
// ── Why it fires DAILY for a WEEKLY digest ─────────────────────────────────
// The route reports on the most recent COMPLETE Monday–Sunday week and is
// idempotent per (site, week) — the unique index on `processor_quota_logs` is
// what enforces that, not this scheduler's aim. So Monday's fire sends, and
// Tuesday through Sunday are no-ops on the same week.
//
// That redundancy is the point. A weekly cron that fires once has exactly one
// chance per week: if the app is redeploying at 06:00 Monday, or the container
// restarts, or M365 is briefly down, the week is simply lost and nobody learns
// anything until the following Monday — by which time the flagged week has
// rolled off. Firing daily means a failed Monday self-heals on Tuesday, and the
// idempotency gate means it can never double-send. Cheap redundancy on the
// recoverable side; the irreversible outcome (mailing three managers twice about
// named employees) is blocked in the database, not by hoping the clock is right.
//
// Long-running daemon under `unless-stopped`: if the loop throws past the
// per-iteration try/catch, a container restart returns to the same shape.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';
const FIRE_HOUR = 6;
const FIRE_MINUTE = 0;

let stopping = false;

function logTs(message) {
  console.log(`[processor-quota-cron ${new Date().toISOString()}] ${message}`);
}

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
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`.
 *
 * The offset is re-probed ON the target day rather than carried from `from`.
 * The naive "seconds-of-day added to now" version assumes every Pacific day is
 * 86400s and misfires across DST — double-firing on the 25-hour fall-back day
 * and firing an hour late on the 23-hour spring-forward day.
 */
function nextFireInstantAt(from, hour, minute) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

function truncateBody(text, max = 400) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * `redirect: 'manual'` is load-bearing. If the auth middleware ever lost the
 * `/api/internal/` exemption and 307'd this POST to /login, fetch's default
 * redirect-following would turn that into the login page's HTTP 200 and the tick
 * would report success having sent nothing. A redirect is ALWAYS a failure here.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/processor-quota`, {
    method: 'POST',
    headers,
    body: '{}',
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
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(
    `next processor-quota tick at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`,
  );
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`tick complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — processor-quota digest anchored to 06:00 America/Los_Angeles');
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
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

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('processor-quota-cron: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, pacificParts };
