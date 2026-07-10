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

// Read the Pacific wall clock off a UTC instant — same technique as
// `src/lib/time.ts` and `scripts/bonus-period-close.mjs`, so "what time is it in
// Pacific" is DST-correct without hardcoding the -7/-8 offset. Re-derived here
// (not imported from `@/lib/time`) because this wrapper stays plain JS and runs
// from the runner stage without a TS compile step.
const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Pacific wall-clock parts (numbers) for a UTC instant. */
function pacificParts(at) {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Signed offset (ms) such that `utc = pacificWallClockAsUTC - offset`. */
function pacificOffsetMs(at) {
  const p = pacificParts(at);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - at.getTime();
}

/**
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`,
 * strictly after `from`. DST-correct via the OFFSET-REPROBE technique ported from
 * `scripts/bonus-period-close.mjs` (`msUntilNext0700Pacific`): resolve the target
 * Pacific wall time on each candidate Pacific calendar day and convert to a true
 * UTC instant using the offset in effect ON THAT DAY.
 *
 * This replaces the earlier "delta seconds-of-day added to `from`" version, which
 * assumed every Pacific day is 86400s and so misfired across DST: it DOUBLE-FIRED
 * on fall-back (the 25h day — it landed 1h early, then the loop recomputed and
 * fired again at the real wall clock) and fired 1h LATE on spring-forward (the 23h
 * day). Anchoring to the calendar day + that day's offset lands exactly on
 * `hour:minute` PT every day of the year.
 */
function nextFireInstantAt(from, hour, minute) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    // Re-probe the offset AT the target instant so a DST jump on the target day is
    // handled (that morning's offset may differ from `from`'s offset).
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000); // defensive fallback (should never hit)
}

/**
 * Read HH:MM from a `@db.Time` value. Prisma round-trips a TIME column as a
 * Date whose UTC hours/minutes ARE the configured wall-clock (no zone).
 */
function hmFromTime(d) {
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// ── POST the internal route ─────────────────────────────────────────

/** Keep logged response bodies short — an unexpected HTML page (e.g. a login
 * redirect target) must not dump kilobytes into the container log. */
function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one fire: POST the internal, loopback-guarded daily-report route. The
 * route fires whichever sites are due (idempotent). Resolves on success; throws
 * on transport / redirect / non-200 so the caller's try/catch logs it.
 *
 * `redirect: 'manual'` is load-bearing (the 2026-07-03 survey-cron lesson): if
 * the /api/internal/bonus/ public-paths exemption were ever missing, the auth
 * middleware would 307 this POST to /login and fetch's default redirect-follow
 * would turn the login page's 200 into a "successful" fire that sends nothing.
 * A redirect is ALWAYS a failure here; only a direct 200 counts.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/daily-report`, {
    method: 'POST',
    headers,
    redirect: 'manual',
  });
  const text = await res.text();
  if (res.status !== 200) {
    const loc = res.headers.get('location');
    throw new Error(`HTTP ${res.status}${loc ? ` (redirect → ${loc})` : ''}: ${truncateBody(text)}`);
  }
  return truncateBody(text);
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

export { nextFireInstantAt, hmFromTime, runFireOnce, truncateBody };
