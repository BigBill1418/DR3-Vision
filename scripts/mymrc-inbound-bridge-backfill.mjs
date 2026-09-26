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
// 2026-09-25 (OPEN-ITEMS 0.CA) — "the floor must not move" is only the right
// expectation when every bridged day is at/before the anchor. Re-bridging a
// POST-anchor day that MRC has corrected (the reason this script is run at all
// since ADR-0089/0.BZ) SHOULD move the floor — by exactly the corrected units. The
// old gate could not tell the two apart, so the 0.BZ re-bridge of 09-15 (+107, one
// haul MRC had since given its units) paged "[DR3-Vision] MyMRC sync error - admin
// … anchor-safety gate FAILED" while the hourly sync was healthy. The gate now
// computes the EXPECTED move from the bridge's own per-day writes on the days the
// floor counts (on/after the probe's `inboundSinceDay`) and requires the actual move
// to equal it, pool by pool. A row that lands on the wrong side of the anchor still
// fails (actual != expected), which is the bug the gate exists to catch. If the
// probe does not report `inboundSinceDay` (older app), the expectation is zero —
// the original strict gate.
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
//   0 — bridge ran and the live floor moved by EXACTLY the units it rewrote on
//       post-anchor days (zero when it rewrote none), or --dry-run.
//   1 — floor moved by anything else (INVESTIGATE — a delivery-date encoding bug), a
//       probe failed, or an unhandled fatal error.
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

/**
 * Parse a Decimal string from the probe ("1412", "1305.0", "-3.5") to an integer
 * count of TENTHS. Every pool is `Decimal(7,1)` or an integer, so tenths are exact;
 * a string with more precision than that is refused (NaN) rather than rounded, so
 * a sub-tenth drift can never be rounded into agreement.
 */
export function toTenths(v) {
  const s = String(v).trim();
  const m = /^(-?)(\d+)(?:\.(\d))?0*$/.exec(s);
  if (!m) return Number.NaN;
  const t = Number(m[2]) * 10 + Number(m[3] ?? 0);
  return m[1] === '-' ? -t : t;
}

/**
 * The floor move the bridge's writes SHOULD cause at one site: the sum of
 * (after - before) over the days `onHand` counts, i.e. `day >= inboundSinceDay`.
 * With no `inboundSinceDay` (no anchor at all) every day counts. `sinceDay ===
 * undefined` means the probe did not say — expect zero (the strict gate).
 * Returned in tenths, per pool. An insert's `before` is zero.
 */
export function expectedFloorMove(writes, siteId, sinceDay) {
  const out = { program: 0, nonProgram: 0, days: [] };
  if (sinceDay === undefined) return out;
  for (const w of writes ?? []) {
    if (w.siteId !== siteId) continue;
    if (sinceDay !== null && w.day < sinceDay) continue;
    const bp = w.before ? w.before.program : 0;
    const bn = w.before ? w.before.nonProgram : 0;
    const dp = Math.round((w.after.program - bp) * 10);
    const dn = Math.round((w.after.nonProgram - bn) * 10);
    out.program += dp;
    out.nonProgram += dn;
    out.days.push(`${w.day} ${fmtSigned(dp)}/${fmtSigned(dn)}`);
  }
  return out;
}

function fmtSigned(tenths) {
  const v = tenths / 10;
  return `${v >= 0 ? '+' : ''}${v}`;
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
    const snap = { program: body.program, nonProgram: body.nonProgram, total: body.total };
    // Absent (older app) → undefined → strict zero-move gate. null → no anchor.
    if ('inboundSinceDay' in body) snap.inboundSinceDay = body.inboundSinceDay;
    return snap;
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
  const idByCode = {};
  if (opts.siteCodes) {
    const rows = await prisma.site.findMany({
      where: { code: { in: opts.siteCodes } },
      select: { id: true, code: true },
    });
    siteIds = rows.map((r) => r.id);
    for (const r of rows) idByCode[r.code] = r.id;
    if (siteIds.length === 0) {
      logFn('error', `no sites resolved for --site=${opts.siteCodes.join(',')}`);
      return 1;
    }
  } else if (typeof prisma.site?.findMany === 'function') {
    const rows = await prisma.site.findMany({
      where: { code: { in: probeSites } },
      select: { id: true, code: true },
    });
    for (const r of rows) idByCode[r.code] = r.id;
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

  // Per site: the move the floor actually made vs the move the writes explain.
  const unexplained = [];
  for (const c of probeSites) {
    const exp = expectedFloorMove(res.writes, idByCode[c], before[c].inboundSinceDay);
    const actP = toTenths(after[c].program) - toTenths(before[c].program);
    const actN = toTenths(after[c].nonProgram) - toTenths(before[c].nonProgram);
    const actT = toTenths(after[c].total) - toTenths(before[c].total);
    const ok =
      actP === exp.program && actN === exp.nonProgram && actT === exp.program + exp.nonProgram;
    const moved = !floorsEqual(before[c], after[c]);
    if (ok && moved) {
      logFn(
        'info',
        `${c}: floor moved ${before[c].program}/${before[c].nonProgram}/${before[c].total} -> ` +
          `${after[c].program}/${after[c].nonProgram}/${after[c].total}, EXACTLY the units rewritten on days ` +
          `counted since ${before[c].inboundSinceDay ?? 'the beginning (no anchor)'}: ${exp.days.join(', ')}. ` +
          `Explained — not a gate failure.`,
      );
    }
    if (!ok) {
      unexplained.push(c);
      logFn(
        'error',
        `LIVE FLOOR MOVED UNEXPLAINED for ${c}: before ${before[c].program}/${before[c].nonProgram}/${before[c].total} ` +
          `-> after ${after[c].program}/${after[c].nonProgram}/${after[c].total} (program ${fmtSigned(actP)}, ` +
          `non-program ${fmtSigned(actN)}); the bridge's writes on counted days explain ` +
          `${fmtSigned(exp.program)}/${fmtSigned(exp.nonProgram)}` +
          (exp.days.length ? ` [${exp.days.join(', ')}]` : ' (no counted day was rewritten)') +
          `. A bridged row landed on the wrong side of the anchor (delivery-date encoding bug) or something ` +
          `else wrote inventory during the run — INVESTIGATE before trusting inventory.`,
      );
    }
  }

  if (unexplained.length > 0) {
    // Page so the failure is loud (ADR-0036 dr3-vision-system). Its OWN kind, not
    // `error`: that kind's title is "MyMRC sync error", and this is neither the sync
    // nor necessarily MyMRC — on 2026-09-25 that title read to Bill as "the sync is
    // broken" while every scheduled run was green (OPEN-ITEMS 0.CA).
    if (typeof mymrc.ntfyPager?.page === 'function') {
      await mymrc.ntfyPager
        .page({
          kind: 'bridge_gate',
          site: unexplained.join(','),
          message:
            `Manual inbound-bridge backfill: the live floor moved by more or less than the days it rewrote ` +
            `explain (${unexplained.join(', ')}). The hourly MyMRC sync is not implicated by this alert. ` +
            `Floor may be wrong until investigated; the script's output has the per-day figures.`,
          fingerprint: 'inbound-bridge-floor-drift',
          click: `https://dr3-vision.svdp.us/dashboard/${unexplained[0]}/loads-inventory`,
        })
        .catch(() => undefined);
    }
    return 1;
  }

  logFn('info', 'floor gate PASSED — every floor move is explained by the rewritten post-anchor days (or none).');
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
  // ADR-0130 — this is a ONE-SHOT process: without the durable cooldown ledger
  // every page it publishes bypasses ADR-0037 entirely (a fresh empty Map per run).
  mymrc.setCooldownDb(prisma);
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
