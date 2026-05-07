#!/usr/bin/env node
// Cron wrapper for the MyMRC scheduled-hauls scrape (T-015 / ADR-0009).
//
// Invoked once per hour by the `mymrc-scrape` container in
// `docker-compose.yml`. For each site (eugene, woodland):
//
//   1. Read credentials from env. If missing, log "creds not configured,
//      skipping" and continue WITHOUT publishing to ntfy — that's an
//      operator state, not a system error.
//   2. Run a Playwright scrape against MyMRC.
//   3. Upsert results into `expected_loads` (insert / update / cancel
//      stale rows in the same window).
//   4. On scrape OR upsert failure, publish a `dr3-vision-system` ntfy
//      with a per-site fingerprint so a 30-min cooldown suppresses
//      storms.
//
// Exit code:
//   - 0 when both sites complete (including no-creds skips)
//   - 1 only when ALL configured sites failed; partial failure is 0
//     so the next cron tick gets a clean retry without container
//     restart-policy thrashing.
//
// This file deliberately stays JavaScript (.mjs) so it runs from the
// runner stage without a TS compile step at runtime. The TS modules
// under `src/lib/mymrc/` are pre-compiled at Docker build time into
// `dist/mymrc/` (CommonJS) by `npx tsc --project tsconfig.mymrc.json`
// in the builder stage; this wrapper consumes that compiled output via
// `createRequire`.

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Compiled output location. The Dockerfile copies `dist/mymrc/` from
// the builder stage into the runner. Local dev: `npm run build:mymrc`
// regenerates it (see package.json scripts).
const MYMRC_DIST = resolve(__dirname, '..', 'dist', 'mymrc');
const mymrc = require(MYMRC_DIST);

const SITES = ['eugene', 'woodland'];
const HEADLESS = (process.env.MYMRC_HEADLESS ?? 'true').toLowerCase() !== 'false';
const NTFY_TOPIC = process.env.NTFY_TOPIC_SYSTEM?.trim() || 'dr3-vision-system';
const NTFY_PRIMARY_BASE = process.env.NTFY_BASE_URL?.trim() || 'https://ntfy.barnardhq.com';
const NTFY_FALLBACK_BASE = 'https://ntfy.sh';
// Pinned obscured fallback topic for `dr3-vision-system` from
// `~/noc-master/data/ntfy-fallback-topics.yml`. Same value as
// `src/lib/ntfy.ts` and `scripts/migrate-with-ntfy.mjs` use.
const NTFY_FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
const NTFY_CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const NTFY_TIMEOUT_MS = 5_000;

async function publishSystemAlert({ title, body, fingerprint }) {
  const token = process.env.NTFY_PUBLISHER_TOKEN?.trim();
  if (!token) return;
  const fullTitle = `[DR3-Vision] ${title}`.slice(0, 250);
  const fingerprintFooter = `\n\nfingerprint=${fingerprint}`;
  const headers = {
    'X-Title': fullTitle,
    Priority: 'high',
    Click: NTFY_CLICK_URL,
    Tags: 'mymrc,scrape,error,dr3-vision',
    Authorization: `Bearer ${token}`,
  };
  const ok = await postWithTimeout(
    `${NTFY_PRIMARY_BASE}/${NTFY_TOPIC}`,
    body + fingerprintFooter,
    headers,
    NTFY_TIMEOUT_MS,
  );
  if (ok) return;
  const fbHeaders = {
    'X-Title': `[FALLBACK] ${fullTitle}`.slice(0, 250),
    Priority: 'high',
    Click: NTFY_CLICK_URL,
    Tags: 'mymrc,scrape,error,dr3-vision',
  };
  await postWithTimeout(
    `${NTFY_FALLBACK_BASE}/${NTFY_FALLBACK_TOPIC}`,
    body + fingerprintFooter,
    fbHeaders,
    NTFY_TIMEOUT_MS,
  );
}

async function postWithTimeout(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    if (!resp.ok) {
      await resp.text().catch(() => '');
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runOneSite({ site, prisma, browser }) {
  const creds = mymrc.loadSiteCredentials(site);
  if (!creds) {
    console.log(`mymrc-scrape: ${site} — credentials not configured, skipping`);
    return { site, status: 'no-credentials' };
  }
  try {
    const result = await mymrc.scrapeSite(browser, creds);
    const summary = await mymrc.upsertScrapedHauls({
      prisma,
      site,
      hauls: result.hauls,
      scrapedAt: result.scraped_at,
    });
    console.log(
      `mymrc-scrape: ${site} ok — hauls=${result.hauls.length} ` +
        `inserted=${summary.inserted} updated=${summary.updated} cancelled=${summary.cancelled} ` +
        `unmatchedSources=${summary.unmatched_source_count}`,
    );
    return {
      site,
      status: 'ok',
      haulCount: result.hauls.length,
      upserted: summary.inserted + summary.updated,
      cancelled: summary.cancelled,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`mymrc-scrape: ${site} FAILED — ${msg}`);
    await publishSystemAlert({
      title: `MyMRC scrape failed — ${site}`,
      body: `Scrape for ${site} failed:\n${msg}`,
      fingerprint: `mymrc-scrape-fail:${site}`,
    });
    return { site, status: 'error', error: msg };
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('mymrc-scrape: DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless: HEADLESS });

  const outcomes = [];
  try {
    for (const site of SITES) {
      // Sites run sequentially: shared browser process, separate
      // contexts (one per site, per ADR-0009). Sequential keeps
      // resource use predictable on CHAD-HQ; the whole pair completes
      // well within the hourly cron tick.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await runOneSite({ site, prisma, browser });
      outcomes.push(outcome);
    }
  } finally {
    await browser.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }

  const configured = outcomes.filter((o) => o.status !== 'no-credentials');
  const failed = outcomes.filter((o) => o.status === 'error');
  if (configured.length > 0 && failed.length === configured.length) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('mymrc-scrape: fatal', err);
  process.exit(1);
});
