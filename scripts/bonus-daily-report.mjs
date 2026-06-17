#!/usr/bin/env node
// ADR-0030 — Daily production report cron (thin Pacific scheduler).
//
// Architecture (BUILD-CONTRACT divergence #1; mirrors bonus-period-close.mjs →
// /api/internal/bonus/close-months): this .mjs imports ONLY `@prisma/client`
// (plain JS, no tsx, no TS import — the prod image is `npm ci --omit=dev` and
// tsx is a devDependency, so `node --import tsx` would crash in prod). It reads
// the enabled configs' `send_time_pt` to compute the soonest next fire across
// all sites, sleeps until it, then POSTs the internal, loopback-guarded route.
// The route fires WHICHEVER sites are due (it does the build/send/log-write
// inside the compiled Next app via `runDailyReportFire`) and is idempotent
// (the bonus_daily_report_log unique on (site, report_date) blocks a second
// send), so a slightly-early/late POST — or a container restart that re-fires —
// is safe. NO email, NO aggregation, NO TS import here.
//
// Long-running daemon, same restart shape as bonus-period-close /
// bonus-eod-check: a single process under `unless-stopped`. If the loop ever
// throws past the per-iteration try/catch, the container restart brings us back
// to the same shape (read configs → compute soonest fire → sleep → POST).

import { PrismaClient } from '@prisma/client';

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Re-check cadence when there are zero enabled configs (a config could be
// enabled at any time via the admin UI without restarting this daemon).
const IDLE_RECHECK_MS = 5 * 60 * 1000;

let stopping = false;

function logTs(message) {
  console.log(`[bonus-daily-report ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helpers (handoff part-2 §8; re-derived in JS, no @/lib/time
// import — this wrapper stays plain JS and runs without a TS compile step). ──

/**
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`,
 * strictly at/after `from`. DST-correct: the Intl formatter does the zone math.
 * If today's hh:mm PT has already passed, it rolls to tomorrow's.
 */
function nextFireInstantAt(from, hour, minute) {
  const FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(FMT.formatToParts(from).map((p) => [p.type, p.value]));
  const currentSecondsOfDay =
    Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const fireSecondsOfDay = hour * 3600 + minute * 60;
  let deltaSec;
  if (currentSecondsOfDay < fireSecondsOfDay) {
    deltaSec = fireSecondsOfDay - currentSecondsOfDay;
  } else {
    deltaSec = 86400 - currentSecondsOfDay + fireSecondsOfDay;
  }
  return new Date(from.getTime() + deltaSec * 1000);
}

/**
 * Read HH:MM from a `@db.Time` value. Prisma round-trips a TIME column as a
 * Date whose UTC hours/minutes ARE the configured wall-clock (no zone).
 */
function hmFromTime(d) {
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// ── POST the internal route ─────────────────────────────────────────

/**
 * Drive one fire: POST the internal, loopback-guarded daily-report route. The
 * route fires whichever sites are due (idempotent). Resolves on success; throws
 * on transport / non-2xx so the caller's try/catch logs it.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/daily-report`, {
    method: 'POST',
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return text;
}

// ── Schedule ────────────────────────────────────────────────────────

async function loadEnabledConfigs(prisma) {
  return prisma.bonusDailyReportConfig.findMany({
    where: { enabled: true },
    select: { send_time_pt: true, site: { select: { code: true } } },
  });
}

/**
 * One scheduler iteration: read enabled configs, sleep until the soonest next
 * fire across them (or the idle re-check window if none), then POST the route.
 * Per-iteration try/catch so a transient DB/HTTP error logs and retries next
 * tick. Returns when the sleep + POST cycle completes (caller loops).
 */
async function tick(prisma) {
  const configs = await loadEnabledConfigs(prisma);
  if (configs.length === 0) {
    logTs(`no enabled configs — checking again in ${Math.round(IDLE_RECHECK_MS / 60000)}min`);
    await sleep(IDLE_RECHECK_MS);
    return;
  }

  const now = new Date();
  const fires = configs.map((cfg) => {
    const { hour, minute } = hmFromTime(cfg.send_time_pt);
    return { code: cfg.site.code, fire: nextFireInstantAt(now, hour, minute) };
  });
  fires.sort((a, b) => a.fire.getTime() - b.fire.getTime());
  const next = fires[0];
  const sleepMs = Math.max(0, next.fire.getTime() - now.getTime());
  logTs(
    `next fire at ${next.fire.toISOString()} for ${next.code} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`,
  );
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`fire complete: ${text}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('bonus-daily-report: DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  setupShutdown(prisma);
  logTs('daemon starting — daily report anchored to each enabled site send_time_pt (America/Los_Angeles)');

  while (!stopping) {
    try {
      await tick(prisma);
    } catch (err) {
      logTs(`tick failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
      // Back off briefly so a hard-down dependency doesn't hot-loop.
      await sleep(30_000);
    }
  }

  await prisma.$disconnect().catch(() => {});
}

function setupShutdown(prisma) {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    prisma
      .$disconnect()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only start the daemon when run as the entrypoint — keeps the module
// importable (for a smoke/helper test) without spawning timers or a DB client.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('bonus-daily-report: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, hmFromTime };
