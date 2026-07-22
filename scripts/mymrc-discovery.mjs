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

// Output root for the discovery report + per-object fixtures. Defaults to the
// repo root (docs/ + src/lib/mymrc/__fixtures__/ land in-tree for local dev),
// but is OVERRIDABLE so the container — which runs as uid 1001 with a read-only
// /app — can point discovery at a writable mounted volume (ADR-0057 Phase 0:
// the first live run died with EACCES writing under /app). The repo layout is
// preserved under the override so the artifacts are trivially copied back.
const OUT_DIR = process.env.MYMRC_DISCOVERY_OUT_DIR?.trim() || REPO_ROOT;

// Require compiled modules directly (not the index barrel) so this runner stays
// on files disjoint from the concurrent transport rework.
const disc = require(resolve(MYMRC_DIST, 'discovery.js'));
const store = require(resolve(MYMRC_DIST, 'credential-store.js'));
const portal = require(resolve(MYMRC_DIST, 'portal-client.js'));
const ntfy = require(resolve(MYMRC_DIST, 'ntfy.js'));
const { LOGIN_URL, AUTHED_HOME_URL, PORTAL_ORIGIN, OBJECT_NAV_SLUGS } = require(
  resolve(MYMRC_DIST, 'selectors.js'),
);

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

// Hardened auth check (ADR-0057 Phase 0): the old runner keyed only on the URL +
// a visible username field, so `/s/home` — a 404 "Error" shell for EVERYONE —
// read as "logged in" and the loud AuthFailedError never fired. Delegate to the
// shared, fixture-tested `looksLoggedOut` (positive auth-marker predicate).
async function isLoggedOut(page) {
  const usernameFieldVisible = await page
    .getByPlaceholder('Username')
    .first()
    .isVisible()
    .catch(() => false);
  const html = await page.content().catch(() => '');
  return portal.looksLoggedOut({ url: page.url(), html, usernameFieldVisible });
}

// Mirrors portal-client.login() (that helper is not exported): the live Lightning
// form fields have no `name` + dynamic ids, so fill by PLACEHOLDER and submit by
// ROLE. Single admin identity — no per-site context (D1).
async function login(page, creds) {
  if (!page.url().includes('/login')) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.getByPlaceholder('Username').first().fill(creds.username);
  await page.getByPlaceholder('Password').first().fill(creds.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    page
      .getByRole('button', { name: /log ?in/i })
      .first()
      .click(),
  ]);
  await page.waitForTimeout(3_000);
}

// Read the authenticated nav's `/s/` links from the DOM (a fallback / supplement
// to the getNavigationMenu Aura response). `$$eval` is Playwright's element-query
// API — the callback runs in the page context purely to serialize `href`
// attributes back to Node; it is NOT JavaScript `eval` and executes no dynamic
// code. The returned strings are filtered by the pure `objectSlugFromHref`.
async function navHrefsFromDom(page) {
  return page
    .$$eval('a[href*="/s/"]', (as) => as.map((a) => a.getAttribute('href')).filter(Boolean))
    .catch(() => []);
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
  const dir = resolve(OUT_DIR, 'src', 'lib', 'mymrc', '__fixtures__', bundle.objectApiName);
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

    // Verify auth against the AUTHENTICATED landing page (/s/), NOT /s/home —
    // the latter is a 404 "Error" shell for authed + anon sessions alike.
    await page.goto(AUTHED_HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    if (await isLoggedOut(page)) {
      log('info', 'login required — authenticating admin session');
      await login(page, creds);
      await page.goto(AUTHED_HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
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

    // Resolve the OBJECT pages to enumerate from the authenticated nav — the
    // getNavigationMenu Aura response first, DOM `/s/` links as supplement, and
    // the static object allowlist as fallback (a hardened run never enumerates
    // nothing). /s/home is NOT a list view, so we never read it.
    const navBodies = await collectAura(page, AUTHED_HOME_URL);
    const domHrefs = await navHrefsFromDom(page);
    const objectSlugs = disc.resolveObjectPages({
      navBodies,
      domHrefs,
      fallbackSlugs: OBJECT_NAV_SLUGS,
    });
    log('info', `nav → ${objectSlugs.length} object page(s): ${objectSlugs.join(', ')}`);

    // Visit each object's ListView page and accumulate its Aura bodies. The
    // per-page getItems actions are the real enumeration source (record ids +
    // columns per object).
    const listBodies = [];
    for (const slug of objectSlugs) {
      const url = `${PORTAL_ORIGIN}/s/${slug}`;
      const bodies = await collectAura(page, url);
      if (await isLoggedOut(page)) {
        throw new portal.AuthFailedError(`mymrc: logged out during /s/${slug} enumeration (discovery)`);
      }
      listBodies.push(...bodies);
      log('info', `/s/${slug}: ${bodies.length} Aura response(s) captured`);
    }
    const objects = disc.enumerateObjects(listBodies, disc.extractAllRecords(listBodies));
    log('info', `enumerated ${objects.length} object(s) from ${objectSlugs.length} nav page(s)`);

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
        listReturnValue: findListReturnValue(listBodies, obj.objectApiName),
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
    const docPath = resolve(OUT_DIR, 'docs', `mymrc-discovery-${capturedAt}.md`);
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
