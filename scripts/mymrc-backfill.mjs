#!/usr/bin/env node
// ADR-0057 Phase 1 (D3) — ONE-SHOT windowed historical backfill runner.
//
// The hourly sync (`scripts/mymrc-scrape.mjs`) only ever sees the FIRST Aura
// `getItems` window per object, so the historical tail of Haul_Request__c /
// Materials__c never lands in the mirrors. THIS runner drains it: it logs in as
// the single admin identity (ADR-0057 D1, reusing the same self-healing session
// plumbing as the sync), builds the offset-paginating portal client
// (`createBackfillPortalClient` over `playwrightBackfillSession`), and drives
// `runBackfill(buildBackfillTargets(...))` — paging every list view by offset to
// `hasMoreData:false`, upserting each window into its mirror, then filling detail
// (≤3 concurrency). It is RESUMABLE (durable per-cursor `last_page_index`) and
// IDEMPOTENT (record-id upserts), so it is safe to re-run until every cursor is
// drained; once drained it is a near-instant no-op and the hourly sync maintains
// steady state.
//
// Run it one-shot in the container:
//   docker compose exec <service> node scripts/mymrc-backfill.mjs
// Optional overrides (for list views whose id was not captured live 2026-07-22):
//   MYMRC_LISTVIEW_IDS='{"consumer_drop_off_rc":"00B…","outbound_active":"00B…"}'
//   (JSON map of DR3 list_view_api_name slug → Salesforce list-view id). Highest
//   authority; lets an operator unblock a not-yet-resolved view without a deploy.
//   Full key set (8 cursors, ADR-0057 D3 — ACTIVE + HISTORY views):
//     Haul_Request__c : "docking_appointments_rc", "consumer_drop_off_rc",
//                       "completed_hauls"                    (HISTORY)
//     Materials__c    : "processed_active", "processed_inactive" (HISTORY),
//                       "outbound_active",  "outbound_inactive"  (HISTORY)
//     Dock_Availability_Schedule__c : ""  (the dock cursor's slug is the EMPTY string)
//   Observed-live ids (fallback when neither runtime capture nor override supply one):
//     docking_appointments_rc=00B4p000005DAqWEAW, processed_active=00B4p000005DAqlEAG,
//     completed_hauls=00B4p000005DAqSEAW, processed_inactive=00BUJ000001sJxx2AE,
//     outbound_inactive=00BUJ000001sJuj2AE. The other 3 (consumer_drop_off_rc,
//     outbound_active, "") have NO observed id → resolve at runtime or via override.
//
// Fail-loud parity with the sync (ADR-0057 D5/D9):
//   0 — every cursor complete (or only transient detail gaps left — re-run drains).
//   1 — a target WEDGED / auth-failed (already paged by the engine), or the admin
//       session failed to start (paged here), or an unhandled fatal error.
//   2 — DATABASE_URL missing.
//   3 — D9: admin credentials not configured in the store.
//   4 — D9: credentials present but undecryptable.

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS = (process.env.MYMRC_HEADLESS ?? 'true').toLowerCase() !== 'false';
const ADMIN_SURFACE_URL =
  process.env.MYMRC_ADMIN_SURFACE_URL?.trim() || 'https://dr3-vision.barnardhq.com/admin/mrc-scrape';

function log(level, message) {
  const line = `mymrc-backfill[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** Parse the optional operator list-view id override map from env. Never throws. */
export function parseListViewOverrides(rawJson, logFn = log) {
  if (!rawJson || String(rawJson).trim() === '') return {};
  try {
    const parsed = JSON.parse(String(rawJson));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const out = {};
    for (const [slug, id] of Object.entries(parsed)) {
      if (typeof id === 'string' && id.trim() !== '') out[slug] = id.trim();
    }
    return out;
  } catch (err) {
    logFn('warn', `MYMRC_LISTVIEW_IDS ignored (not a valid {slug:id} JSON object): ${describeErr(err)}`);
    return {};
  }
}

/**
 * Run the one-shot backfill. Collaborators are INJECTED so the flow is
 * unit-testable with fakes and never launches a real browser:
 *   - mymrc:         the compiled `@/lib/mymrc` surface (loadAdminCredentials,
 *                    openAdminSession, playwrightBackfillSession,
 *                    createBackfillPortalClient, buildBackfillTargets, runBackfill,
 *                    ntfyPager, CredentialsNotConfiguredError).
 *   - prisma:        a PrismaClient.
 *   - launchBrowser: `() => Promise<Browser>` — only after the D9 gate passes.
 * Resolves the process exit code; the caller owns `process.exit`.
 */
export async function runMymrcBackfill({ mymrc, prisma, launchBrowser, log: logFn = log, listViewOverrides }) {
  // ── D9 credential gate (assert BEFORE any browser launch) ──
  let creds;
  try {
    creds = await mymrc.loadAdminCredentials(prisma);
  } catch (err) {
    const notConfigured = err instanceof mymrc.CredentialsNotConfiguredError;
    const message = notConfigured
      ? `MyMRC admin credentials not configured — enter them at ${ADMIN_SURFACE_URL}. Backfill cannot run.`
      : `MyMRC admin credentials could not be loaded/decrypted: ${describeErr(err)}. Check MYMRC_CRED_KEY.`;
    logFn('error', message);
    await mymrc.ntfyPager
      .page({
        kind: 'error',
        site: 'admin',
        message,
        fingerprint: notConfigured ? 'mymrc-creds-not-configured' : 'mymrc-creds-load-failed',
      })
      .catch(() => undefined);
    return notConfigured ? 3 : 4;
  }

  const overrides = listViewOverrides ?? parseListViewOverrides(process.env.MYMRC_LISTVIEW_IDS, logFn);
  if (Object.keys(overrides).length > 0) {
    logFn('info', `list-view id override(s) supplied for: ${Object.keys(overrides).join(', ')}`);
  }

  const browser = await launchBrowser();
  let session;
  try {
    try {
      // Reuse the sync's proven, self-healing admin session (ADR-0057 D1).
      session = await mymrc.openAdminSession(browser, creds, { log: logFn });
    } catch (err) {
      const msg = describeErr(err);
      logFn('error', `admin session start failed: ${msg}`);
      await mymrc.ntfyPager
        .page({
          kind: 'auth_failed',
          site: 'admin',
          message: `MyMRC backfill admin login/session failed to start: ${msg}`,
          fingerprint: 'mymrc-auth-failed:admin',
        })
        .catch(() => undefined);
      return 1;
    }

    try {
      const backfillSession = mymrc.playwrightBackfillSession(session, logFn);
      const client = mymrc.createBackfillPortalClient(backfillSession, { log: logFn, listViewOverrides: overrides });
      const targets = mymrc.buildBackfillTargets({ prisma, client, log: logFn });
      const result = await mymrc.runBackfill({ prisma, client, targets, log: logFn });

      const summary = result.targets
        .map(
          (t) =>
            `${t.objectApiName}/${t.listViewApiName || '(default)'}=${t.status}` +
            `(pages:${t.pagesThisRun},listed:${t.recordsListedThisRun},detail:${t.detailsFetched}/${t.detailsFetched + t.detailFailures})`,
        )
        .join(' ');
      logFn('info', `backfill done — complete=${result.complete} · ${summary}`);

      // Per-target wedges/auth were ALREADY paged by the engine (dedup Q4) — do not
      // double-page here. A non-zero exit signals "needs attention / re-run".
      const failed = result.targets.filter((t) => t.status === 'error' || t.status === 'auth_failed');
      return failed.length > 0 ? 1 : 0;
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function describeErr(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log('error', 'DATABASE_URL is required');
    process.exit(2);
  }
  const require = createRequire(import.meta.url);
  const mymrc = require(resolve(__dirname, '..', 'dist', 'mymrc'));
  const prisma = new PrismaClient();
  let code = 1;
  try {
    code = await runMymrcBackfill({
      mymrc,
      prisma,
      launchBrowser: () => chromium.launch({ headless: HEADLESS }),
      log,
    });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  process.exit(code);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    log('error', `fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
