#!/usr/bin/env node
// Per-tick worker for the MyMRC ingestion sync (ADR-0038, rebuild of T-015).
//
// Spawned once per hour by `scripts/mymrc-cron.mjs`. For each site
// (eugene, woodland), sequentially:
//
//   1. Read credentials from env. If missing → log "creds not configured,
//      skipping" and continue WITHOUT paging (operator state, not a system
//      error).
//   2. Log in to the MyMRC Salesforce portal (Playwright) → a session-bound
//      PortalClient (JSON transport; never parses Lightning DOM).
//   3. Run all three feeds (hauls → processed → outbound): list → mirror upsert
//      (first/last_seen + disappeared) → bounded detail pass → ALWAYS a
//      run-ledger row. Hauls also feed `expected_loads`.
//   4. Paging (auth_failed / contract_drift / zero-anomaly) is fired by the sync
//      engine itself via `dr3-vision-system`, deduped per fingerprint.
//
// After all sites, run the DEADMAN check (no successful run in >26h → page).
//
// Exit code:
//   - 0 when every configured site completes (including no-creds skips and
//     per-feed errors — the next tick retries cleanly without restart thrash).
//   - 1 only when EVERY configured site failed to even start a session.
//
// Stays JavaScript (.mjs): the TS modules under `src/lib/mymrc/` are precompiled
// to `dist/mymrc/` (CJS) at Docker build time via `tsconfig.mymrc.json`; this
// wrapper consumes that output through `createRequire`.

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MYMRC_DIST = resolve(__dirname, '..', 'dist', 'mymrc');
const mymrc = require(MYMRC_DIST);

const SITES = mymrc.SITE_CODES ?? ['eugene', 'woodland'];
const HEADLESS = (process.env.MYMRC_HEADLESS ?? 'true').toLowerCase() !== 'false';

function log(level, message) {
  const line = `mymrc-sync[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

async function runOneSite({ site, prisma, browser }) {
  const creds = mymrc.loadSiteCredentials(site);
  if (!creds) {
    log('info', `${site} — credentials not configured, skipping`);
    return { site, status: 'no-credentials' };
  }
  let client;
  try {
    client = await mymrc.createPortalClient(browser, creds, {
      log: (lvl, msg) => log(lvl, msg),
    });
  } catch (err) {
    // Could not even start a session (login/context failure). The sync engine
    // fires the auth page on its list attempt; here we just record the outcome.
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `${site} — session start failed: ${msg}`);
    return { site, status: 'session-failed', error: msg };
  }
  try {
    const results = await mymrc.syncSite({
      prisma,
      client,
      site,
      log: (lvl, msg) => log(lvl, msg),
    });
    const summary = results
      .map((r) => `${r.feed}=${r.status}(listed:${r.rowsListed},detail:${r.detailsFetched})`)
      .join(' ');
    log('info', `${site} done — ${summary}`);
    return { site, status: 'ran', results };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log('error', 'DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless: HEADLESS });

  const outcomes = [];
  try {
    for (const site of SITES) {
      // Sites run sequentially: shared browser, one login/context per site.
      outcomes.push(await runOneSite({ site, prisma, browser }));
    }
    // Deadman: page once (deduped) for any feed with no success in >26h.
    await mymrc.checkDeadman({ prisma, sites: SITES, log: (lvl, msg) => log(lvl, msg) });
  } finally {
    await browser.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }

  const configured = outcomes.filter((o) => o.status !== 'no-credentials');
  const startedNone = configured.filter((o) => o.status === 'session-failed');
  if (configured.length > 0 && startedNone.length === configured.length) {
    process.exit(1); // every configured site failed to even start a session
  }
  process.exit(0);
}

main().catch((err) => {
  log('error', `fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
