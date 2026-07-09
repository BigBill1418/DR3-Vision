#!/usr/bin/env node
// ADR-0049 D2 — workbook-sync poll cron (thin 10-minute scheduler).
//
// Architecture (mirrors scripts/ap-poll-cron.mjs): this .mjs imports NOTHING (no
// @prisma/client, no tsx, no TS). Every 10 minutes it POSTs the internal,
// loopback-guarded route `/api/internal/workbook-sync/poll` with the
// `INTERNAL_CRON_TOKEN` bearer when set, logs the (truncated) outcome, and loops.
//
// The route does ALL the real work inside the Next app via `runWorkbookSyncPoll`:
// transport select (mock/live, self-reported), business-hours ENFORCEMENT (the route
// no-ops off-hours per D2 — the daemon ticks around the clock and the route gates),
// current-month file discovery + rollover, delta-detect, parse, workbook-wins upsert
// with audit-per-overwrite, mid-edit skip, and a workbook_sync_runs ledger row.
//
// `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if the
// public-paths exemption for /api/internal/workbook-sync/ were ever missing, the auth
// middleware would 307 this POST to /login and fetch's default redirect-follow would
// turn the login page's 200 into a "successful" no-op poll. A redirect is ALWAYS a
// failure here; only a direct 200 from the route counts.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const TICK_MS = 10 * 60 * 1000; // 10 minutes (D2)
const BOOT_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 30_000;

let stopping = false;

function logTs(message) {
  console.log(`[workbook-sync-cron ${new Date().toISOString()}] ${message}`);
}

function truncateBody(text, max = 400) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/workbook-sync/poll`, {
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
  logTs(`daemon starting — workbook sync poll every ${TICK_MS / 60000}min → ${BASE}/api/internal/workbook-sync/poll`);
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

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('workbook-sync-cron: fatal', err);
    process.exit(1);
  });
}

export { runFireOnce, truncateBody };
