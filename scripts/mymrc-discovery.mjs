#!/usr/bin/env node
// ADR-0057 Phase 0 — MyMRC object-discovery runner (D2/D5/D6).
//
// ONE-SHOT, operator-invoked (not the hourly cron). Enumerates every Salesforce
// object Bill's admin account can see and writes:
//   - docs/mymrc-discovery-<date>.md               (the D6 deliverable)
//   - src/lib/mymrc/__fixtures__/<objectApiName>/   (redacted per-object bundle)
//
// This is a THIN runner: all enumeration / field-extraction / redaction / render
// logic lives in the unit-tested pure module `src/lib/mymrc/discovery.ts`
// (compiled to dist/mymrc/discovery.js). This file only drives Playwright and
// does file I/O.
//
// GATED ON CREDENTIALS: reads Bill's admin login from the DB credential store
// (ADR-0057 D1 — no .env). If the store is empty, discovery cannot run — it
// exits non-zero with an instruction to enter credentials in the admin surface.
// Login failure is a loud, no-fallback AuthFailedError + ntfy page (D5).
//
// Prereqs: `npm run build:mymrc` (compiles the TS modules to dist/mymrc/),
// DATABASE_URL, MYMRC_CRED_KEY (to decrypt the stored password), and a
// credential row set via the admin surface.
//
// Run:  node scripts/mymrc-discovery.mjs

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MYMRC_DIST = resolve(__dirname, '..', 'dist', 'mymrc');
const REPO_ROOT = resolve(__dirname, '..');

// Require compiled modules directly (not the index barrel) so this runner stays
// on files disjoint from the concurrent transport rework.
const disc = require(resolve(MYMRC_DIST, 'discovery.js'));
const store = require(resolve(MYMRC_DIST, 'credential-store.js'));
const portal = require(resolve(MYMRC_DIST, 'portal-client.js'));
const ntfy = require(resolve(MYMRC_DIST, 'ntfy.js'));
const { SELECTORS, LOGIN_URL } = require(resolve(MYMRC_DIST, 'selectors.js'));

const PORTAL_ORIGIN = 'https://mrc-us.my.site.com';
const HOME_URL = `${PORTAL_ORIGIN}/s/home`;
const SOBJECTS_PATH = '/services/data/v58.0/sobjects/';
const AURA_URL_RE = /\/s\/sfsites\/aura/i;
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000;
const HEADLESS = (process.env.MYMRC_HEADLESS ?? 'true').toLowerCase() !== 'false';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 DR3VisionScraper/1.0';

function log(level, message) {
  const line = `mymrc-discovery[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function adminAuthStatePath() {
  const root = process.env.MYMRC_AUTH_STATE_DIR?.trim() || `${process.env.HOME ?? '/tmp'}/.dr3-vision`;
  return `${root}/mymrc-admin/auth.json`;
}

function detailUrl(recordId) {
  return `${PORTAL_ORIGIN}/s/detail/${encodeURIComponent(recordId)}`;
}

async function isLoggedOut(page) {
  if (/\/s\/login(\/|\?|$)/i.test(page.url())) return true;
  return page
    .locator(SELECTORS.loginRedirectMarker)
    .first()
    .isVisible()
    .catch(() => false);
}

// Mirrors portal-client.login() (that helper is not exported; the sequence is a
// 3-selector fill+submit). Single admin identity — no per-site context (D1).
async function login(page, creds) {
  if (!page.url().includes('/login')) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.locator(SELECTORS.loginEmailField).first().fill(creds.username);
  await page.locator(SELECTORS.loginPasswordField).first().fill(creds.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    page.locator(SELECTORS.loginSubmitButton).first().click(),
  ]);
  await page.waitForTimeout(3_000);
}

// Navigate and collect every intercepted Aura response body during load+settle.
async function collectAura(page, url) {
  const bodies = [];
  const onResponse = (resp) => {
    if (!AURA_URL_RE.test(resp.url())) return;
    resp
      .text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  };
  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'networkidle' }).catch((e) => {
      log('warn', `goto ${url} — ${e && e.message ? e.message : e}`);
    });
    await page.waitForTimeout(SETTLE_MS);
  } finally {
    page.off('response', onResponse);
  }
  return bodies;
}

// Find the raw getItems returnValue for an object (for the list fixture).
function findListReturnValue(bodies, objectApiName) {
  for (const body of bodies) {
    for (const action of disc.parseAuraActions(body)) {
      if (action.state !== 'SUCCESS' || !disc.isGetItemsAction(action)) continue;
      const entity = action.params && action.params.entityName;
      if (entity === objectApiName) return action.returnValue;
    }
  }
  return { recordIdActionsList: [] };
}

async function probeSObjects(context) {
  try {
    const resp = await context.request.get(`${PORTAL_ORIGIN}${SOBJECTS_PATH}`, {
      failOnStatusCode: false,
      timeout: NAV_TIMEOUT_MS,
    });
    const body = await resp.text().catch(() => '');
    return disc.summarizeSobjectsProbe(resp.status(), body);
  } catch (err) {
    return disc.summarizeSobjectsProbe(0, err && err.message ? err.message : String(err));
  }
}

async function writeObjectFixture(bundle) {
  const dir = resolve(REPO_ROOT, 'src', 'lib', 'mymrc', '__fixtures__', bundle.objectApiName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'list-getItems-response.json'),
    `${JSON.stringify(bundle.listResponse, null, 2)}\n`,
  );
  await writeFile(
    resolve(dir, 'record-getRecordWithFields-response.json'),
    `${JSON.stringify(bundle.recordResponse, null, 2)}\n`,
  );
  await writeFile(
    resolve(dir, 'discovery-metadata.json'),
    `${JSON.stringify(bundle.metadata, null, 2)}\n`,
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log('error', 'DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  let creds;
  try {
    creds = await store.getMymrcCredentials(prisma);
  } finally {
    // creds read is the only prisma use; disconnect happens in the outer finally.
  }
  if (!creds) {
    log(
      'error',
      'MyMRC admin credentials are not configured. Enter them in the admin surface, then re-run. (ADR-0057 D1/D9 — no .env path.)',
    );
    await prisma.$disconnect().catch(() => undefined);
    process.exit(3);
  }

  const capturedAt = today();
  const stateFile = adminAuthStatePath();
  await mkdir(dirname(stateFile), { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  let exitCode = 0;
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
      ...(existsSync(stateFile) ? { storageState: stateFile } : {}),
    });
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    if (await isLoggedOut(page)) {
      log('info', 'login required — authenticating admin session');
      await login(page, creds);
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    if (await isLoggedOut(page)) {
      // D5: loud, no fallback.
      await ntfy.ntfyPager.page({
        kind: 'auth_failed',
        site: 'admin',
        message: 'MyMRC Phase 0 discovery could not authenticate the admin session',
        fingerprint: ntfy.fingerprint.authFailed('admin'),
      });
      await context.storageState({ path: stateFile }).catch(() => undefined);
      throw new portal.AuthFailedError('mymrc: still logged out after admin login (discovery)');
    }
    await context.storageState({ path: stateFile }).catch(() => undefined);

    // Enumerate from the home shell, then one detail per object.
    const homeBodies = await collectAura(page, HOME_URL);
    const objects = disc.enumerateObjects(homeBodies, disc.extractAllRecords(homeBodies));
    log('info', `enumerated ${objects.length} object(s) from /s/home`);

    const reportObjects = [];
    for (const obj of objects) {
      const apiName = obj.objectApiName ?? (obj.keyPrefix ? `Unknown_${obj.keyPrefix}` : 'Unknown');
      const sampleRecordId = obj.recordIds[0] ?? null;
      let record = null;
      if (sampleRecordId) {
        const detailBodies = await collectAura(page, detailUrl(sampleRecordId));
        if (await isLoggedOut(page)) {
          throw new portal.AuthFailedError(`mymrc: logged out during ${apiName} detail (discovery)`);
        }
        record = disc.extractRecordFields(detailBodies, sampleRecordId);
      }
      const reportRow = {
        objectApiName: apiName,
        keyPrefix: obj.keyPrefix,
        listViews: obj.listViews,
        columns: obj.columns,
        count: obj.count,
        sampleRecordId,
        fieldNames: record ? Object.keys(record.fields).sort() : [],
      };
      reportObjects.push(reportRow);

      const bundle = disc.buildObjectFixture({
        report: reportRow,
        listReturnValue: findListReturnValue(homeBodies, obj.objectApiName),
        record,
        capturedAt,
      });
      await writeObjectFixture(bundle);
      log('info', `${apiName}: ${reportRow.fieldNames.length} field(s), ${obj.recordIds.length} id(s) — fixture written`);
    }

    const sobjectsProbe = await probeSObjects(context);
    log('info', `sObjects probe: HTTP ${sobjectsProbe.status} (${sobjectsProbe.reachable ? 'reachable' : 'blocked'})`);

    const markdown = disc.renderDiscoveryMarkdown({
      capturedAt,
      portalOrigin: PORTAL_ORIGIN,
      accountLabel: 'dr3-admin',
      objects: reportObjects,
      sobjectsProbe,
    });
    const docPath = resolve(REPO_ROOT, 'docs', `mymrc-discovery-${capturedAt}.md`);
    await mkdir(dirname(docPath), { recursive: true });
    await writeFile(docPath, markdown);
    log('info', `wrote ${docPath}`);
  } catch (err) {
    exitCode = 1;
    log('error', `discovery failed: ${err && err.stack ? err.stack : err}`);
  } finally {
    await browser.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  log('error', `fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
