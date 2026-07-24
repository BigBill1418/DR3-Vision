#!/usr/bin/env node
// ADR-0059 — ONE-SHOT hauls → inventory INBOUND bridge backfill.
//
// The hourly scrape (`scripts/mymrc-scrape.mjs`) only bridges a trailing ~10-day
// window. THIS runner bridges the FULL dated history once, so `inbound_loads`
// (which had no MyMRC-sourced inbound before ADR-0059) gains one PROVISIONAL
// aggregate row per (Woodland site, delivery day) for every dated Delivered General
// haul. It needs NO MyMRC login/browser — it only reads the already-synced
// `mymrc_hauls_mirror` and writes `inbound_loads` via the compiled bundle
// (`dist/mymrc`).
//
// MONEY-SAFE GO-LIVE GATE (ADR-0059 D5, MANDATORY): every dated Delivered General haul
// is ≤ the latest physical anchor (2026-07-22), so `onHand` (inbound window
// `gte` Pacific-midnight of the day AFTER the anchor) excludes them and the LIVE FLOOR
// must not move. This runner PROVES that in practice: it probes `onHand(site, asOf)` via
// the internal floor-probe route (ADR-0058) BEFORE and AFTER the write (same `asOf`), and
// ABORTS non-zero if the floor drifted by a single unit.
//
// Run it from the APP container (it has INTERNAL_CRON_TOKEN + can reach the internal
// route on 127.0.0.1:3000, and the shared image carries dist/mymrc):
//   docker compose exec app node scripts/mymrc-inbound-bridge-backfill.mjs --backfill
// Flags:
//   --backfill            full dated history (default when no --since)
//   --since=YYYY-MM-DD    only delivery days on/after this Pacific day
//   --site=woodland[,eugene]   restrict to these site codes (default: both)
//   --dry-run             compute + classify only; NO writes, NO floor gate
//
// Exit codes:
//   0 — bridge ran and the live floor was byte-identical before/after (or --dry-run).
//   1 — floor drifted (INVESTIGATE — a delivery-date encoding bug), a probe failed, or
//       an unhandled fatal error.
//   2 — DATABASE_URL missing.

import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INTERNAL_BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const INTERNAL_TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';
const PROBE_TIMEOUT_MS = 10_000;

function log(level, message) {
  const line = `mymrc-inbound-bridge-backfill[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** Parse argv into the backfill options. Pure/testable. */
export function parseArgs(argv) {
  const opts = { dryRun: false, siteCodes: null, since: null };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--backfill') {
      /* explicit full-history (the default) — accepted for clarity */
    } else if (a.startsWith('--since=')) {
      const v = a.slice('--since='.length).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since must be YYYY-MM-DD (got "${v}")`);
      opts.since = v;
    } else if (a.startsWith('--site=')) {
      const codes = a
        .slice('--site='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const bad = codes.filter((c) => c !== 'woodland' && c !== 'eugene');
      if (bad.length) throw new Error(`--site accepts woodland|eugene (got "${bad.join(',')}")`);
      opts.siteCodes = codes.length ? codes : null;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

/** True iff two floor snapshots are byte-identical on all three pools. */
export function floorsEqual(a, b) {
  return a.program === b.program && a.nonProgram === b.nonProgram && a.total === b.total;
}

/** POST the internal floor-probe route for one site at a FIXED asOf. Throws on any non-200. */
async function probeFloor(siteCode, asOfIso) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (INTERNAL_TOKEN) headers.authorization = `Bearer ${INTERNAL_TOKEN}`;
    const res = await fetch(`${INTERNAL_BASE}/api/internal/inventory/floor-probe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ siteCode, asOf: asOfIso }),
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`floor-probe ${siteCode} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = JSON.parse(text);
    return { program: body.program, nonProgram: body.nonProgram, total: body.total };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the one-shot INBOUND backfill with the mandatory floor-invariance gate.
 * Collaborators are INJECTED so the flow is unit-testable with fakes:
 *   - mymrc:      the compiled `@/lib/mymrc` surface (bridgeInboundHaulsToInventory).
 *   - prisma:     a PrismaClient (mirror read + inbound_loads write + site resolve).
 *   - probe:      `(siteCode, asOfIso) => Promise<{program,nonProgram,total}>`.
 *   - opts:       parsed args.
 * Resolves the process exit code; the caller owns `process.exit`.
 */
export async function runInboundBridgeBackfill({ mymrc, prisma, probe, opts, log: logFn = log }) {
  const probeSites = opts.siteCodes ?? ['woodland', 'eugene'];

  // Resolve site codes → ids when restricted (the bridge takes siteIds).
  let siteIds;
  if (opts.siteCodes) {
    const rows = await prisma.site.findMany({
      where: { code: { in: opts.siteCodes } },
      select: { id: true, code: true },
    });
    siteIds = rows.map((r) => r.id);
    if (siteIds.length === 0) {
      logFn('error', `no sites resolved for --site=${opts.siteCodes.join(',')}`);
      return 1;
    }
  }

  const sinceDeliveryDate = opts.since ? new Date(`${opts.since}T00:00:00.000Z`) : undefined;
  const bridgeCtx = { prisma, log: logFn, dryRun: opts.dryRun };
  if (siteIds) bridgeCtx.siteIds = siteIds;
  if (sinceDeliveryDate) bridgeCtx.sinceDeliveryDate = sinceDeliveryDate;

  if (opts.dryRun) {
    const res = await mymrc.bridgeInboundHaulsToInventory(bridgeCtx);
    logFn(
      'info',
      `DRY-RUN — would: days=${res.daysConsidered} ins=${res.inserted} upd=${res.updated} ` +
        `skip=${res.skippedGuarded} same=${res.unchanged} undated=${res.haulsUndated} ` +
        `(NO writes, NO floor gate)`,
    );
    return 0;
  }

  // ── MANDATORY floor-invariance gate (ADR-0059 D5) ──
  // One fixed asOf for BOTH probes so the comparison isolates the bridge's writes from
  // clock advance.
  const asOfIso = new Date().toISOString();
  const before = {};
  for (const code of probeSites) before[code] = await probe(code, asOfIso);
  logFn(
    'info',
    `floor BEFORE @ ${asOfIso}: ` +
      probeSites.map((c) => `${c}=${before[c].program}/${before[c].nonProgram}/${before[c].total}`).join(' '),
  );

  const res = await mymrc.bridgeInboundHaulsToInventory(bridgeCtx);
  logFn(
    'info',
    `bridge wrote: days=${res.daysConsidered} ins=${res.inserted} upd=${res.updated} ` +
      `skip=${res.skippedGuarded} same=${res.unchanged} undated=${res.haulsUndated}`,
  );

  const after = {};
  for (const code of probeSites) after[code] = await probe(code, asOfIso);
  logFn(
    'info',
    `floor AFTER  @ ${asOfIso}: ` +
      probeSites.map((c) => `${c}=${after[c].program}/${after[c].nonProgram}/${after[c].total}`).join(' '),
  );

  const drifted = probeSites.filter((c) => !floorsEqual(before[c], after[c]));
  if (drifted.length > 0) {
    for (const c of drifted) {
      logFn(
        'error',
        `LIVE FLOOR DRIFTED for ${c}: before ${before[c].program}/${before[c].nonProgram}/${before[c].total} ` +
          `!= after ${after[c].program}/${after[c].nonProgram}/${after[c].total}. A bridged inbound row landed ` +
          `at/after the anchor unexpectedly (delivery-date encoding bug) — INVESTIGATE before trusting inventory. ` +
          `(Expected non-zero drift ONLY if post-anchor delivery days were bridged.)`,
      );
    }
    // Page the fleet so the drift is loud (ADR-0036 dr3-vision-system).
    if (typeof mymrc.ntfyPager?.page === 'function') {
      await mymrc.ntfyPager
        .page({
          kind: 'error',
          site: 'admin',
          message: `inbound-bridge backfill: LIVE FLOOR DRIFTED for ${drifted.join(', ')} — anchor-safety gate FAILED. Investigate.`,
          fingerprint: 'inbound-bridge-floor-drift',
        })
        .catch(() => undefined);
    }
    return 1;
  }

  logFn('info', 'floor-invariance gate PASSED — live floor byte-identical before/after.');
  return 0;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log('error', 'DATABASE_URL is required');
    process.exit(2);
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    log('error', describeErr(err));
    process.exit(1);
  }

  const require = createRequire(import.meta.url);
  const mymrc = require(resolve(__dirname, '..', 'dist', 'mymrc'));
  const prisma = new PrismaClient();
  let code = 1;
  try {
    code = await runInboundBridgeBackfill({ mymrc, prisma, probe: probeFloor, opts, log });
  } catch (err) {
    log('error', `fatal: ${describeErr(err)}`);
    code = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  process.exit(code);
}

function describeErr(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    log('error', `fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
