#!/usr/bin/env node
// ADR-0057 Phase 1 (D3 addendum, 2026-07-22) — ONE-SHOT BATCH detail-enrichment runner.
//
// The billing gap this closes: mirror rows carry Salesforce record ids (from the
// list pass / backfill) but the billing unit-counts live only on the DETAIL record,
// and the old per-record `/s/detail/<id>` navigation captured ~0.4% of them (racy
// settle window). This runner replays `getRecordWithFields` as a BATCHED direct
// Aura POST (~100 record-ids/POST, record-fields-client) reusing the list-page
// envelope — enriching the whole `detail_fetched_at IS NULL` backlog in minutes.
//
// It does NOT paginate (the ids are already in the mirrors); it drives the
// `enrichDetails` engine over the backfill targets, which reads each mirror's null
// set, chunks 100, POSTs, maps via the EXISTING mappers, writes the billing fields,
// and stamps `detail_fetched_at`. Resumable + idempotent off the null cursor: a
// crash re-selects the still-null rows next run.
//
// Run one-shot in the container:
//   docker compose --profile mymrc run --rm mymrc-scrape node scripts/mymrc-enrich-details.mjs
//
// Exit codes (parity with mymrc-backfill.mjs):
//   0 — every target swept (transient per-id ERRORs may remain — re-run drains).
//   1 — a target logged out / a zero-SUCCESS batch (already paged), or session start failed.
//   2 — DATABASE_URL missing.
//   3 — D9: admin credentials not configured.
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
const BATCH_SIZE = Number(process.env.MYMRC_ENRICH_BATCH_SIZE ?? '100') || 100;
const PACING_MS = Number(process.env.MYMRC_ENRICH_PACING_MS ?? '1000');

function log(level, message) {
  const line = `mymrc-enrich[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

// The four mirror models keyed by a human label — used for the BEFORE/AFTER
// reconciliation report (detail_fetched vs total per object).
const MIRRORS = [
  ['hauls', 'mymrcHaulsMirror'],
  ['processed', 'mymrcProcessedMirror'],
  ['outbound', 'mymrcOutboundMirror'],
  ['dock', 'mymrcDockAvailabilityMirror'],
];

async function coverage(prisma) {
  const out = {};
  for (const [label, model] of MIRRORS) {
    const total = await prisma[model].count();
    const fetched = await prisma[model].count({ where: { detail_fetched_at: { not: null } } });
    out[label] = { total, fetched };
  }
  return out;
}

/**
 * Run the one-shot enrichment. Collaborators are INJECTED so the flow is
 * unit-testable with fakes and never launches a real browser:
 *   - mymrc:         the compiled `@/lib/mymrc` surface (loadAdminCredentials,
 *                    openAdminSession, playwrightRecordFieldsSession,
 *                    createRecordFieldsClient, buildBackfillTargets, enrichDetails,
 *                    ntfyPager, CredentialsNotConfiguredError).
 *   - prisma:        a PrismaClient.
 *   - launchBrowser: `() => Promise<Browser>` — only after the D9 gate passes.
 * Resolves the process exit code; the caller owns `process.exit`.
 */
export async function runMymrcEnrich({ mymrc, prisma, launchBrowser, log: logFn = log }) {
  // ── D9 credential gate (assert BEFORE any browser launch) ──
  let creds;
  try {
    creds = await mymrc.loadAdminCredentials(prisma);
  } catch (err) {
    const notConfigured = err instanceof mymrc.CredentialsNotConfiguredError;
    const message = notConfigured
      ? `MyMRC admin credentials not configured — enter them at ${ADMIN_SURFACE_URL}. Enrichment cannot run.`
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

  const before = await coverage(prisma);
  logFn(
    'info',
    'coverage BEFORE — ' +
      MIRRORS.map(([l]) => `${l}=${before[l].fetched}/${before[l].total}`).join(' '),
  );

  const browser = await launchBrowser();
  let session;
  try {
    try {
      session = await mymrc.openAdminSession(browser, creds, { log: logFn });
    } catch (err) {
      const msg = describeErr(err);
      logFn('error', `admin session start failed: ${msg}`);
      await mymrc.ntfyPager
        .page({
          kind: 'auth_failed',
          site: 'admin',
          message: `MyMRC enrichment admin login/session failed to start: ${msg}`,
          fingerprint: 'mymrc-auth-failed:admin',
        })
        .catch(() => undefined);
      return 1;
    }

    try {
      const recordFields = mymrc.createRecordFieldsClient(
        mymrc.playwrightRecordFieldsSession(session, logFn),
        { log: logFn },
      );
      // buildBackfillTargets needs a pagination client for its type, but the enrich
      // engine never paginates — pass a stub that throws if pagination is attempted.
      const stubClient = {
        fetchListPage: async () => {
          throw new Error('mymrc-enrich: pagination is not used by the enrichment engine');
        },
      };
      const targets = mymrc.buildBackfillTargets({ prisma, client: stubClient, log: logFn });

      const result = await mymrc.enrichDetails({
        prisma,
        client: recordFields,
        targets,
        log: logFn,
        batchSize: BATCH_SIZE,
        pacingMs: PACING_MS,
      });

      const after = await coverage(prisma);
      logFn(
        'info',
        'coverage AFTER — ' +
          MIRRORS.map(([l]) => `${l}=${after[l].fetched}/${after[l].total}`).join(' '),
      );
      for (const t of result.targets) {
        if (t.requested === 0) continue;
        const errNote = t.errored > 0 ? ` errored=[${t.erroredIds.join(', ')}${t.errored > t.erroredIds.length ? ', …' : ''}]` : '';
        logFn(
          'info',
          `${t.objectApiName}/${t.listViewApiName || '(default)'} — requested=${t.requested} fetched=${t.fetched} ` +
            `errors=${t.errored} missing=${t.missing}${errNote}`,
        );
      }

      const failed = result.targets.filter((t) => t.auth);
      return failed.length > 0 || !result.complete ? 1 : 0;
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
    code = await runMymrcEnrich({
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
