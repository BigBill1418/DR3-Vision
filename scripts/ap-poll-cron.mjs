#!/usr/bin/env node
// ADR-0046 D5 — AP mailbox poll cron (thin 10-minute scheduler).
//
// Architecture (mirrors scripts/survey-reminder-cron.mjs): this .mjs imports
// NOTHING (no @prisma/client, no tsx, no TS). Every 10 minutes it POSTs the
// internal, loopback-guarded route `/api/internal/ap/poll` with the
// `INTERNAL_CRON_TOKEN` bearer when set, logs the (truncated) outcome, and loops.
//
// The route does ALL the real work inside the Next app via `runApPoll`: transport
// select (mock/live, self-reported), Graph delta list, per-message ingest
// (sender-auth → sanitize → attachments → request/followup/quarantine), move to
// Processed, an ap_poll_runs ledger row ALWAYS (incl. throw paths), and the 45-min
// deadman page. It is idempotent (internet_message_id UNIQUE), so a restart-driven
// re-fire or an overlapping tick can never double-ingest.
//
// `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if the
// public-paths exemption for /api/internal/ap/ were ever missing, the auth
// middleware would 307 this POST to /login and fetch's default redirect-follow
// would turn the login page's 200 into a "successful" no-op poll. A redirect is
// ALWAYS a failure here; only a direct 200 from the route counts.
//
// Long-running daemon under `unless-stopped`: if the loop throws past the
// per-iteration try/catch, the container restart brings us back to the same shape.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const TICK_MS = 10 * 60 * 1000; // 10 minutes (C9-D3)
const BOOT_DELAY_MS = 5_000; // small delay so postgres/app healthchecks likely settled
const ERROR_BACKOFF_MS = 30_000;

let stopping = false;

function logTs(message) {
  console.log(`[ap-poll-cron ${new Date().toISOString()}] ${message}`);
}

/** Keep logged bodies short — an unexpected HTML page must not dump kilobytes. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one poll: POST the internal, loopback-guarded route. Resolves on a direct
 * 200; throws on transport / redirect / non-200 so the caller's try/catch logs it.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/ap/poll`, {
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

async function main() {
  setupShutdown();
  logTs(`daemon starting — AP mailbox poll every ${TICK_MS / 60000}min → ${BASE}/api/internal/ap/poll`);
  await sleep(BOOT_DELAY_MS);

  while (!stopping) {
    try {
      const text = await runFireOnce();
      logTs(`poll complete: ${text}`);
      await sleep(TICK_MS);
    } catch (err) {
      logTs(`poll failed (non-fatal, retry after backoff): ${err?.message ?? err}`);
      await sleep(ERROR_BACKOFF_MS);
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
// (for a potential schedule-helper test) without spawning timers.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('ap-poll-cron: fatal', err);
    process.exit(1);
  });
}

export { runFireOnce, truncateBody };
