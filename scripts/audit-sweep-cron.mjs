#!/usr/bin/env node
// ADR-0039 D3 — Audit nightly-sweep cron (thin Pacific scheduler).
//
// Architecture (mirrors scripts/survey-reminder-cron.mjs → the internal route):
// this .mjs imports NOTHING (no @prisma/client, no tsx, no TS). The fire time is
// fixed at 02:30 America/Los_Angeles — the quiet window after the day's entries.
// It computes the next 02:30 PT instant (DST-correct via Intl formatToParts),
// sleeps until it, then POSTs the internal, loopback-guarded route
// (`/api/internal/audit/sweep`) with the `INTERNAL_CRON_TOKEN` bearer when set,
// logs the outcome, and loops.
//
// The route does all the real work (per-site trailing-14d window, comparators
// with live leg-fetchers, findings lifecycle, run ledger, failure ntfy) compiled
// inside the Next app via `runAuditSweep`. It is idempotent: re-running a window
// upserts findings by fingerprint, so a slightly-early/late POST or a container
// restart never duplicates. A no-op fires cleanly when no comparators are wired.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed daily fire: 02:30 America/Los_Angeles (ADR-0039).
const FIRE_HOUR = 2;
const FIRE_MINUTE = 30;

let stopping = false;

function logTs(message) {
  console.log(`[audit-sweep-cron ${new Date().toISOString()}] ${message}`);
}

/**
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`,
 * strictly at/after `from`. DST-correct: the Intl formatter does the zone math.
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

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded sweep route.
 *
 * `redirect: 'manual'` is load-bearing: if the auth middleware were ever missing
 * the /api/internal/audit/ exemption it would 307 this POST to /login — fetch's
 * default redirect-following would turn that into the login page's 200 and the
 * sweep would "succeed" while doing nothing. A redirect is ALWAYS a failure
 * here; only a direct 200 from the route counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/audit/sweep`, {
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

async function tick() {
  const now = new Date();
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(`next audit sweep at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`);
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`sweep complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — audit sweep anchored to 02:30 America/Los_Angeles');

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logTs(`sweep failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
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
    console.error('audit-sweep-cron: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, runFireOnce, truncateBody };
