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

// ── Session-start failure ledger + paging policy (ADR-0111) ─────────────────
//
// Before this, a tick that never got a session wrote NOTHING to
// `mymrc_sync_runs` — `openAdminSession` throws before the first feed row is
// created. So the ledger read 100% green straight through the 2026-08-18
// incident, and the only trace was a container log that a redeploy destroys.
// A `__session__` row makes the failure class visible to every ledger query.
//
// It also fixes the paging decision. The old page fired on the FIRST failed
// tick, from a cooldown Map that lives in the per-tick process and is therefore
// empty on every tick — no cross-tick memory at all, so a self-healing blip
// paged anyway (ADR-0037 Q3: page after self-heal has been given its chance,
// not before). Counting the ledger rows gives real cross-tick memory: a lone
// blip stays silent, and a genuinely dead session pages on the retry ~9 minutes
// later.
const SESSION_FEED = '__session__';
// 75 min, NOT 60: the steady-state cadence is hourly, so two consecutive
// top-of-hour failures sit ~60 min apart — a 60-min `gte` window put the prior
// row exactly on the boundary and back-to-back hourly failures could never
// page. Seen 2026-08-26: the 1:00 PM tick died at Chromium launch; had 2:00 PM
// died too, a 60-min window would have stayed silent.
const SESSION_REPEAT_WINDOW_MS = 75 * 60 * 1000;
const SESSION_PAGE_AFTER = 2; // this failure + at least one more in the window

/**
 * Ledger a session-start failure and report how many have landed in the window.
 *
 * FAILS OPEN on its own errors: if the bookkeeping cannot be written, it returns
 * `Infinity` so the caller still pages. Broken bookkeeping must never be able to
 * silence a real outage.
 */
export async function recordSessionFailure({
  prisma,
  activeSites,
  message,
  status = 'auth_failed',
  log: logFn = log,
}) {
  try {
    const code = Array.isArray(activeSites) ? activeSites[0] : undefined;
    const site =
      (code ? await prisma.site.findFirst({ where: { code }, select: { id: true } }) : null) ??
      (await prisma.site.findFirst({ select: { id: true }, orderBy: { code: 'asc' } }));
    if (!site?.id) {
      logFn('warn', 'mymrc: no site row to attribute the session failure to — paging anyway');
      return { ledgered: false, recent: Number.POSITIVE_INFINITY };
    }
    const now = new Date();
    await prisma.mymrcSyncRun.create({
      data: {
        site_id: site.id,
        feed: SESSION_FEED,
        started_at: now,
        finished_at: now,
        status,
        error: message,
      },
    });
    // Count per-FEED, not per-status: a login failure followed by a launch
    // crash is still two consecutive dead ticks and must page the same way.
    const recent = await prisma.mymrcSyncRun.count({
      where: {
        feed: SESSION_FEED,
        started_at: { gte: new Date(now.getTime() - SESSION_REPEAT_WINDOW_MS) },
      },
    });
    return { ledgered: true, recent };
  } catch (err) {
    logFn('warn', `mymrc: could not ledger the session failure (${describeErr(err)}) — paging anyway`);
    return { ledgered: false, recent: Number.POSITIVE_INFINITY };
  }
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

  // The OTHER way a tick never gets a session: Chromium itself dies at launch
  // (chrome-headless-shell SIGSEGV — 2026-08-18 boot slot, 2026-08-26 1:00 PM
  // top-of-hour). Uncaught, the throw skipped the ADR-0111 guard entirely —
  // no `__session__` row, no page, straight to the top-level `fatal:` handler,
  // and the ledger read green through the whole class. Same ledger + same
  // paging policy as a login failure: a lone blip stays silent (the next tick
  // heals it), a repeat inside the window pages.
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    const msg = describeErr(err);
    logFn('error', `browser launch failed: ${msg}`);
    const { recent } = await recordSessionFailure({
      prisma,
      activeSites,
      message: `browser launch failed: ${msg}`,
      status: 'error',
      log: logFn,
    });
    if (recent < SESSION_PAGE_AFTER) {
      logFn(
        'warn',
        `mymrc: browser launch failed (${recent} session failure(s) in the window) — NOT paging yet, the next tick decides (ADR-0037 Q3)`,
      );
      return 1;
    }
    await mymrc.ntfyPager
      .page({
        kind: 'error',
        site: 'admin',
        message:
          `MyMRC browser launch failed — ${recent} session-level failures in the last 75 min ` +
          `(latest: ${msg}). The scrape never reached the portal; the run ledger has __session__ rows. ` +
          `Status surface: ${ADMIN_SURFACE_URL}.`,
        fingerprint: 'mymrc-launch-failed:admin',
      })
      .catch(() => undefined);
    return 1;
  }
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
      const { recent } = await recordSessionFailure({
        prisma,
        activeSites,
        message: msg,
        log: logFn,
      });
      if (recent < SESSION_PAGE_AFTER) {
        // ADR-0037 Q3 — let the system try to heal itself first. The cron retries
        // in ~9 minutes; if that one fails too, the next call pages.
        logFn(
          'warn',
          `mymrc: session start failed (${recent} in the last hour) — NOT paging yet, the retry decides (ADR-0037 Q3)`,
        );
        return 1;
      }
      await mymrc.ntfyPager
        .page({
          kind: 'auth_failed',
          site: 'admin',
          message:
            `MyMRC admin login/session failed to start ${recent}x in the last hour ` +
            `(latest: ${msg}). If this is a credential problem, re-enter it at ${ADMIN_SURFACE_URL}.`,
          fingerprint: 'mymrc-auth-failed:admin',
        })
        .catch(() => undefined);
      return 1;
    }

    // Batched getRecordWithFields detail transport (ADR-0057 D3 addendum) over the
    // SAME admin session as the list client — one login serves list + detail.
    // Replaces the racy per-record `/s/detail/<id>` navigation.
    const recordFields = mymrc.createRecordFieldsClient(
      mymrc.playwrightRecordFieldsSession(client.getSession(), logFn),
      { log: logFn },
    );

    // NEWEST-FIRST LIST PAGINATION (2026-07-31). The default list transport is
    // PASSIVE — it reads whichever getItems window the portal UI happened to fire,
    // which is the list view's ASCENDING page 0, i.e. the OLDEST records. Measured
    // live: processed/outbound returned entry dates 2024-03-01…2024-05-09 every
    // hour, so records created after 2026-07-22 could never enter the mirror and
    // both mirrors froze for 9 days while every run recorded `ok`. Wrapping the
    // client makes the list pass replay getItems with `sortBy:'-Id'` over a bounded
    // page budget. The `typeof` guards keep injected-fake test harnesses working.
    let listClient = client;
    if (
      typeof mymrc.withNewestFirstList === 'function' &&
      typeof mymrc.playwrightBackfillSession === 'function'
    ) {
      const budget =
        typeof mymrc.paginationFromEnv === 'function'
          ? mymrc.paginationFromEnv(process.env, logFn)
          : {};
      listClient = mymrc.withNewestFirstList(
        client,
        mymrc.playwrightBackfillSession(client.getSession(), logFn),
        { ...budget, log: logFn },
      );
      logFn(
        'info',
        `mymrc: list pass paginates NEWEST-FIRST (pageSize=${budget.pageSize ?? 'default'}, maxPages=${budget.maxPages ?? 'default'})`,
      );
    } else {
      // Never silently fall back to the oldest-first window — that IS the defect.
      logFn(
        'warn',
        'mymrc: newest-first list pagination is unavailable in this build — the list pass will read the portal default (oldest-first) window',
      );
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
        const results = await mymrc.syncSite({ prisma, client: listClient, recordFields, site, log: logFn });
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

      // ADR-0058 — bridge the freshly-refreshed processed mirror into inventory
      // (`processed_units_daily`, the Stripped leg). Runs right after the mirror is
      // current so ordering is guaranteed (mirror-fresh → bridge). Only the trailing
      // window is re-aggregated each tick (the precedence guard makes a wider window
      // harmless — the one-time full backfill is a separate script). Best-effort,
      // non-fatal: a bridge failure must not turn a good scrape tick into a non-zero
      // exit. The `typeof` guard keeps injected-fake test harnesses working unchanged.
      if (typeof mymrc.bridgeProcessedToInventory === 'function') {
        try {
          const br = await mymrc.bridgeProcessedToInventory({
            prisma,
            sinceProductionDate: recentProcessedFloor(),
            log: logFn,
          });
          logFn(
            'info',
            `processed-bridge — ins:${br.inserted} upd:${br.updated} skip:${br.skippedGuarded} same:${br.unchanged}`,
          );
        } catch (err) {
          logFn('error', `processed-bridge failed (non-fatal): ${describeErr(err)}`);
        }
      }

      // ADR-0059 — bridge the freshly-refreshed hauls mirror into inventory
      // (`inbound_loads`, the PROVISIONAL Inbound leg) right after the processed bridge,
      // so ordering is guaranteed (mirror-fresh → bridge) and both legs feed the balance
      // within the hour. Only the trailing window is re-aggregated each tick (the
      // precedence guard + absolute-value writes make a wider window harmless — the
      // one-time full backfill is a separate script). Best-effort, non-fatal: a bridge
      // failure must not turn a good scrape tick into a non-zero exit. The `typeof` guard
      // keeps injected-fake test harnesses working unchanged.
      if (typeof mymrc.bridgeInboundHaulsToInventory === 'function') {
        try {
          const ir = await mymrc.bridgeInboundHaulsToInventory({
            prisma,
            sinceDeliveryDate: recentProcessedFloor(),
            log: logFn,
          });
          logFn(
            'info',
            `inbound-bridge — ins:${ir.inserted} upd:${ir.updated} skip:${ir.skippedGuarded} same:${ir.unchanged} undated:${ir.haulsUndated}`,
          );
        } catch (err) {
          logFn('error', `inbound-bridge failed (non-fatal): ${describeErr(err)}`);
        }
      }

      // ADR-0089 D2 — the genuinely-dateless residual is ALERTABLE. A Delivered
      // General haul that has been DETAILED (so it was asked) and carries no date
      // on either key field is a data-quality question for MRC — the one case
      // where "ask MRC" is the right move. Windowed to the same trailing floor as
      // the bridge so the pre-Am.1 backlog (D4's job) can never storm the topic.
      // Best-effort, non-fatal; per-site fingerprint, 24h cooldown (ADR-0037 Q4).
      if (typeof mymrc.findDatelessDeliveredHauls === 'function') {
        try {
          const dateless = await mymrc.findDatelessDeliveredHauls({
            prisma,
            seenSince: recentProcessedFloor(),
          });
          if (dateless.length > 0) {
            // mirror.site_id is a sites.id — resolve codes for the alert envelope.
            const siteRows = await prisma.site.findMany({ select: { id: true, code: true } });
            const siteCodeById = new Map(siteRows.map((s) => [s.id, s.code]));
            const bySite = new Map();
            for (const h of dateless) {
              const k = h.site_id ?? 'unknown';
              if (!bySite.has(k)) bySite.set(k, []);
              bySite.get(k).push(h);
            }
            for (const [siteId, hauls] of bySite) {
              const site = siteCodeById.get(siteId) ?? siteId;
              const names = hauls
                .map((h) => h.external_haul_id ?? h.id)
                .slice(0, 5)
                .join(', ');
              const units = hauls.reduce(
                (n, h) => n + (h.program_unit_count ?? 0) + (h.non_program_unit_count ?? 0),
                0,
              );
              logFn(
                'warn',
                `dateless Delivered haul(s) at ${site}: ${hauls.length} (${units} units) — ${names}`,
              );
              await mymrc.ntfyPager
                .page({
                  kind: 'dateless_hauls',
                  site,
                  message:
                    `${hauls.length} Delivered haul(s) at ${site} carry units but NO delivery date on ` +
                    `any MyMRC field (${units} units: ${names}). The inbound bridge cannot place them ` +
                    `on a floor day. This is an MRC data-quality question — ask MRC to set ` +
                    `Recycler_Reported_Delivery_Date on these hauls.`,
                  fingerprint: `mymrc-dateless-hauls:${site}`,
                  cooldownMs: 24 * 60 * 60 * 1000,
                })
                .catch(() => undefined);
            }
          }
        } catch (err) {
          logFn('error', `dateless-haul check failed (non-fatal): ${describeErr(err)}`);
        }
      }

      // Deadman: page once (deduped via ledger) for any feed with no success in >26h.
      await mymrc.checkDeadman({ prisma, sites, log: logFn });

      // MIRROR FRESHNESS (2026-07-31). The deadman above asks "did a run succeed
      // recently?" — during the 9-day freeze the answer was yes, 216 times. This
      // asks the only question that actually matters: is what we HOLD current?
      // Pages `high`, at most one per site+feed per day (ADR-0037). Best-effort:
      // a freshness-check failure must not turn a good tick non-zero.
      if (typeof mymrc.checkMirrorFreshness === 'function') {
        try {
          const fresh = await mymrc.checkMirrorFreshness({
            prisma,
            sites,
            pager: mymrc.ntfyPager,
            log: logFn,
          });
          logFn(
            'info',
            `mirror-freshness — ${fresh
              .map(
                (f) =>
                  `${f.feed}=${f.newest ? f.newest.toISOString().slice(0, 10) : 'empty'}${f.stale ? ' STALE' : ''}`,
              )
              .join(' ')}`,
          );
        } catch (err) {
          logFn('error', `mirror-freshness failed (non-fatal): ${describeErr(err)}`);
        }
      }
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

/**
 * The trailing-window floor (a @db.Date-shaped UTC-midnight key, ~10 days back) the
 * hourly bridge re-aggregates so a steady-state tick is cheap and can pick up a
 * portal revision of a recent day. A generous window is safe: the bridge's precedence
 * guard + absolute-value writes make re-checking older days harmless, never a
 * double-count. UTC-vs-Pacific day skew (7–8h) is immaterial at a 10-day floor. The
 * one-time full backfill uses the standalone script with no floor.
 */
export function recentProcessedFloor(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 10));
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
