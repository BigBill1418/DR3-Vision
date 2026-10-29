#!/usr/bin/env node
// ADR-0143 D2/D5 — inventory pool-check cron (thin 10-minute scheduler).
//
// Every 10 minutes, around the clock, POST the app's internal, loopback-guarded
// route `/api/internal/inventory/pool-check` with the `INTERNAL_CRON_TOKEN` bearer.
// The route does all the work inside the Next app: it re-checks every site's pools
// on its own transaction (the only check the standalone MyMRC bridges get, and the
// backstop for any swallowed in-transaction check) and sends any due
// inventory-exception page (onset / 7-day, `high`).
//
// WHY ITS OWN SERVICE (2026-10-29): this call first rode the workbook-sync daemon.
// That container is profile-gated (`profiles: ['workbook-sync']`) and the live
// `.env` has COMPOSE_PROFILES=ap, so the deployer never recreates it: after the
// ADR-0143 deploy it was still a July image with no pool-check, and no exception
// opened until it was recreated by hand. This service is in the DEFAULT profile, so
// every deploy recreates it with the code it ships with.
//
// Imports nothing (no @prisma/client, no TS). `redirect: 'manual'` is load-bearing:
// a 307 to /login is a FAILURE, never a successful no-op (the 2026-07-03 lesson).

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

export const TICK_MS = 10 * 60 * 1000;
const BOOT_DELAY_MS = 30_000; // let the app finish its first boot after a deploy
const ERROR_BACKOFF_MS = 60_000;

let stopping = false;

function logTs(message) {
  console.log(`[inventory-pool-check-cron ${new Date().toISOString()}] ${message}`);
}

export function truncateBody(text, max = 400) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/** One POST. Throws on anything but a direct 200. `fetchFn` is injectable for tests. */
export async function runPoolCheckOnce(fetchFn = fetch, base = BASE, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchFn(`${base}/api/internal/inventory/pool-check`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ writer: 'sweep' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (res.status !== 200) {
    const loc = res.headers?.get?.('location');
    throw new Error(`HTTP ${res.status}${loc ? ` (redirect → ${loc})` : ''}: ${truncateBody(text)}`);
  }
  return truncateBody(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  logTs(`daemon starting — pool-check every ${TICK_MS / 60000}min → ${BASE}/api/internal/inventory/pool-check`);
  await sleep(BOOT_DELAY_MS);
  while (!stopping) {
    try {
      logTs(`pool-check complete: ${await runPoolCheckOnce()}`);
      await sleep(TICK_MS);
    } catch (err) {
      logTs(`pool-check failed (non-fatal, retry after backoff): ${err?.message ?? err}`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('inventory-pool-check-cron: fatal', err);
    process.exit(1);
  });
}
