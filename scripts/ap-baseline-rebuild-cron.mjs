#!/usr/bin/env node
// ADR-0046 Amendment 5 (D-M5-4) — AP vendor-baseline rebuild cron (thin Pacific
// scheduler).
//
// Architecture mirrors scripts/ap-approver-expiry-cron.mjs: this .mjs imports
// NOTHING (no @prisma/client, no tsx, no TS). The fire time is fixed at 01:30
// America/Los_Angeles (after the 00:05 expiry run); it computes the next 01:30 PT
// instant (DST-correct via Intl formatToParts), sleeps until it, then POSTs the
// internal, loopback-guarded route (`/api/internal/ap/baseline-rebuild`) with the
// `INTERNAL_CRON_TOKEN` bearer when set, logs the outcome, and loops.
//
// The route does the real work (recompute every vendor baseline from history,
// preserving admin overrides) compiled inside the Next app via
// `rebuildVendorBaselines`. It is idempotent: a re-fire (or a container restart
// re-run) recomputes the same table.
//
// `redirect: 'manual'` is load-bearing (the survey-cron lesson): a redirect is
// ALWAYS a failure; only a direct 200 from the route counts.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const PACIFIC_TZ = 'America/Los_Angeles';

// Fixed daily fire: 01:30 America/Los_Angeles.
const FIRE_HOUR = 1;
const FIRE_MINUTE = 30;

let stopping = false;

function logTs(message) {
  console.log(`[ap-baseline-rebuild-cron ${new Date().toISOString()}] ${message}`);
}

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

function pacificOffsetMs(at) {
  const p = pacificParts(at);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - at.getTime();
}

/**
 * Next UTC instant at which the Pacific wall clock reads `hour:minute:00`, strictly
 * after `from`. DST-correct via the OFFSET-REPROBE technique (ported from
 * scripts/ap-approver-expiry-cron.mjs): resolve the target Pacific wall time on
 * each candidate Pacific calendar day and convert to a true UTC instant using the
 * offset in effect ON THAT DAY.
 */
function nextFireInstantAt(from, hour, minute) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

function truncateBody(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/ap/baseline-rebuild`, {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  const now = new Date();
  const fire = nextFireInstantAt(now, FIRE_HOUR, FIRE_MINUTE);
  const sleepMs = Math.max(0, fire.getTime() - now.getTime());
  logTs(`next baseline-rebuild tick at ${fire.toISOString()} (in ${(sleepMs / 1000 / 60).toFixed(1)}min)`);
  await sleep(sleepMs);
  if (stopping) return;

  const text = await runFireOnce();
  logTs(`tick complete: ${text}`);
}

async function main() {
  setupShutdown();
  logTs('daemon starting — AP vendor-baseline rebuild anchored to 01:30 America/Los_Angeles');

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logTs(`tick failed (non-fatal, retry next iteration): ${err?.message ?? err}`);
      await sleep(30_000);
    }
  }
}

function setupShutdown() {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('ap-baseline-rebuild-cron: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstantAt, runFireOnce, truncateBody };
