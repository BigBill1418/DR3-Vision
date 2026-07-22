#!/usr/bin/env node
// Per-tick worker for the MyMRC ingestion sync (ADR-0038 transport, ADR-0057
// D1/D9 auth model). Spawned once per hour by `scripts/mymrc-cron.mjs`.
//
// ADR-0057 D1 — SINGLE ADMIN IDENTITY. Vision logs into the MyMRC Salesforce
// portal ONCE as Bill's admin user (no per-site logins, no service accounts —
// those never existed). One Playwright session serves every feed; site scoping
// happens on the DATA (records carry `Recycler__c`), not on the login. The admin
// credential comes from the ENCRYPTED DB store (`getMymrcCredentials`, entered at
// `/admin/mrc-scrape`) — NEVER a `.env`. The scrape decrypts using `MYMRC_CRED_KEY`
// (see docker-compose.yml + docs/operator/mymrc-setup.md).
//
// ADR-0057 D9 — FAIL LOUD ON MISSING CREDS. The historical failure mode (months
// of zero pulls) was startup treating absent credentials as "skip + exit 0". That
// silent path is DELETED. If the store has no admin credential (or it can't be
// decrypted), the worker pages `dr3-vision-system` and exits NON-ZERO. Unconfigured
// is now noisy within one hourly tick, and the Docker healthcheck
// (`scripts/mymrc-healthcheck.mjs`) reports unhealthy until creds are entered.
//
// Exit codes:
//   0  — every site's feeds ran (per-feed errors are handled/ledgered downstream).
//   1  — admin session failed to start, or an unhandled fatal error.
//   2  — DATABASE_URL missing.
//   3  — D9: admin credentials not configured in the store.
//   4  — D9: credentials present but undecryptable (bad/missing MYMRC_CRED_KEY,
//         tampered ciphertext, or an unsupported key_version).
//
// Stays JavaScript (.mjs): the TS modules under `src/lib/mymrc/` are precompiled
// to `dist/mymrc/` (CJS) at Docker build time via `tsconfig.mymrc.json`; this
// wrapper consumes that output through `createRequire`. The `require(dist)` is
// LAZY (inside `main`) so this module stays importable for unit tests without a
// built `dist/`.

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS = (process.env.MYMRC_HEADLESS ?? 'true').toLowerCase() !== 'false';

// Where an operator enters/rotates the admin credential. Surfaced in the D9 page
// so the alert is directly actionable (ADR-0037 gate Q5).
const ADMIN_SURFACE_URL =
  process.env.MYMRC_ADMIN_SURFACE_URL?.trim() ||
  'https://dr3-vision.barnardhq.com/admin/mrc-scrape';

function log(level, message) {
  const line = `mymrc-sync[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/**
 * The recycler contexts to pull THIS run. ADR-0057's admin session lands in ONE
 * recycler context (observed: DR3 Woodland); the MyMRC "Switch Account" transport
 * that reaches the other (Eugene) is not built yet (OPEN-ITEMS C-21). This matters
 * for the DEADMAN: the list pass is GLOBAL, so calling `syncSite` for a site the
 * session cannot see still "succeeds" (it lists the visible context's ids) and
 * writes an `ok` mymrc_sync_run for that site — a FALSE-GREEN that makes
 * `checkDeadman` believe the unpulled site is healthy forever, even though zero of
 * its records are ingested. So we pull ONLY the active context and pass that same
 * set to the deadman: the pilot's single recycler (`woodland`) by default,
 * overridable via `MYMRC_ACTIVE_SITES` (comma list) once Switch-Account lands.
 * Tokens are validated against the known SITE_CODES; unknown tokens are dropped
 * with a warn, and an empty result falls back to the pilot default — never sync
 * (or deadman-watch) nothing silently.
 */
export function resolveActiveSites({ explicit, envValue, known, log: logFn = log }) {
  const knownSet = new Set((known ?? []).map((s) => String(s).toLowerCase()));
  const ok = (s) => knownSet.size === 0 || knownSet.has(s);
  const DEFAULT = ['woodland'];
  const raw = explicit ?? (envValue ? String(envValue).split(',') : null);
  if (!raw) return DEFAULT.filter(ok).length ? DEFAULT.filter(ok) : DEFAULT;
  const cleaned = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const valid = cleaned.filter(ok);
  const dropped = cleaned.filter((s) => !ok(s));
  if (dropped.length) logFn('warn', `mymrc: ignoring unknown MYMRC_ACTIVE_SITES token(s): ${dropped.join(', ')}`);
  if (valid.length === 0) {
    logFn('warn', 'mymrc: no valid active sites resolved from MYMRC_ACTIVE_SITES — falling back to pilot default (woodland)');
    return DEFAULT;
  }
  return valid;
}

/**
 * Orchestrate one scrape tick. Collaborators are INJECTED (`deps`) so the flow is
 * unit-testable with fakes and never touches `dist/` or launches a real browser:
 *   - mymrc:         the compiled `@/lib/mymrc` surface (loadAdminCredentials,
 *                    createPortalClient, syncSite, checkDeadman, ntfyPager, SITE_CODES,
 *                    CredentialsNotConfiguredError).
 *   - prisma:        a PrismaClient.
 *   - launchBrowser: `() => Promise<Browser>` — called ONLY after the D9 credential
 *                    gate passes, so the common "not configured yet" tick never pays
 *                    the Chromium launch cost.
 *   - log:           structured logger.
 * Returns the process exit code; the caller owns `process.exit`.
 */
export async function runMymrcScrape({ mymrc, prisma, launchBrowser, log: logFn = log, activeSites }) {
  // ── D9 credential gate (ADR-0057 D9) — assert BEFORE any browser launch ──
  let creds;
  try {
    creds = await mymrc.loadAdminCredentials(prisma);
  } catch (err) {
    const notConfigured = err instanceof mymrc.CredentialsNotConfiguredError;
    const message = notConfigured
      ? `MyMRC admin credentials not configured — enter them at ${ADMIN_SURFACE_URL}. ` +
        `Sync cannot run until credentials are set.`
      : `MyMRC admin credentials could not be loaded/decrypted: ${describeErr(err)}. ` +
        `Check MYMRC_CRED_KEY on this container and re-enter credentials at ${ADMIN_SURFACE_URL} if needed.`;
    logFn('error', message);
    // Fail LOUD (no silent skip, no fallback — no service accounts exist).
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

  const browser = await launchBrowser();
  let client;
  try {
    // Single admin login (ADR-0057 D1). Storage state defaults to the single admin
    // context path inside portal-client (`adminAuthStatePath()`), honoring
    // MYMRC_AUTH_STATE_DIR.
    try {
      client = await mymrc.createPortalClient(browser, creds, { log: logFn });
    } catch (err) {
      const msg = describeErr(err);
      logFn('error', `admin session start failed: ${msg}`);
      await mymrc.ntfyPager
        .page({
          kind: 'auth_failed',
          site: 'admin',
          message: `MyMRC admin login/session failed to start: ${msg}`,
          fingerprint: 'mymrc-auth-failed:admin',
        })
        .catch(() => undefined);
      return 1;
    }

    // Only the recycler context(s) this session can actually see — never the
    // vestigial second site whose `ok` runs would false-green the deadman (C-21).
    const sites = resolveActiveSites({
      explicit: activeSites,
      envValue: process.env.MYMRC_ACTIVE_SITES,
      known: mymrc.SITE_CODES ?? ['eugene', 'woodland'],
      log: logFn,
    });
    logFn('info', `mymrc: active recycler context(s) this run: ${sites.join(', ')}`);
    try {
      // One admin session; the per-site passes reuse it (feeds are not login-scoped).
      for (const site of sites) {
        const results = await mymrc.syncSite({ prisma, client, site, log: logFn });
        const summary = results
          .map((r) => `${r.feed}=${r.status}(listed:${r.rowsListed},detail:${r.detailsFetched})`)
          .join(' ');
        logFn('info', `${site} done — ${summary}`);
      }
      // ADR-0057 D4 — feed the reconciliation queue: any collection-site name on a
      // freshly-upserted mirror (Materials__c.Account__r.Name /
      // Haul_Request__c.Collection_Site__c) unknown to `sources` becomes a
      // `new_record` candidate for Bill to approve. NEVER auto-writes sources —
      // queue only. Best-effort: a feed failure must not turn a good sync tick into
      // a non-zero exit. The `typeof` guard keeps injected-fake test harnesses
      // (which don't stub this) working unchanged.
      if (typeof mymrc.feedReconciliationQueue === 'function') {
        try {
          const fr = await mymrc.feedReconciliationQueue({ prisma, log: logFn });
          logFn(
            'info',
            `reconcile-feed — ${fr.queued} new candidate(s) queued (${fr.skippedExisting} already queued)`,
          );
        } catch (err) {
          logFn('error', `reconcile-feed failed (non-fatal): ${describeErr(err)}`);
        }
      }

      // Deadman: page once (deduped via ledger) for any feed with no success in >26h.
      await mymrc.checkDeadman({ prisma, sites, log: logFn });
    } finally {
      await client.close().catch(() => undefined);
    }
    return 0;
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
    code = await runMymrcScrape({
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

// Only run as the entrypoint — keeps the module importable for unit tests without
// spawning Prisma/Chromium or requiring a built `dist/` (mirrors the guard in
// scripts/bonus-period-close.mjs).
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    log('error', `fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
