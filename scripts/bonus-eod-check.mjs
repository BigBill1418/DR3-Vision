#!/usr/bin/env node
// ADR-0019 §2 + ADR-0028 — Bi-site EOD bonus-entry enforcement (daemon).
//
// Long-running daemon, same shape as bonus-period-close + bonus-escalation-check:
// sleeps until the next 20:00 Pacific instant, fires, repeats. Per-site
// iteration covers Woodland + Eugene (any site with an active bonus signature
// chain). One ntfy per site that has ZERO entries for the day, fingerprinted
// per (site, date) — a partial day (at least one entry) never pages
// (revised 2026-06-17, ADR-0019 §2).
//
// ── Entry deadline = 20:00 PT (ADR-0019 §2 amendment, 2026-07-21) ────
// The team now works a later shift; the bonus entry deadline is 8:00 PM
// Pacific ("entered by 8pm at the latest"). This daemon fires at that
// deadline: any bonus-enabled site with zero entries for the Pacific day is
// paged as LATE / not-entered. Previously the check fired at 17:00 PT
// (the earlier shift's end-of-day). Nothing else about the decision changed —
// only the fire hour moved 17 → 20.

import { PrismaClient } from '@prisma/client';

const PACIFIC_TZ = 'America/Los_Angeles';
// 20:00 PT — the 8pm entry deadline. DST-correct via nextFireInstant (offset
// reprobe); NEVER a hardcoded UTC offset. Mirrors the deadline the on-save
// report's "late" flag keys off (bonus_daily_report_config.send_time_pt = 20:00).
const FIRE_HOUR_PT = 20;
const FIRE_MINUTE_PT = 0;

const PRIMARY_BASE = process.env['NTFY_BASE_URL']?.trim() || 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';
const TOPIC = process.env['NTFY_TOPIC_SYSTEM']?.trim() || 'dr3-vision-system';
const FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
const CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';

const TIMEOUT_MS = 5_000;

function logTs(message) {
  console.log(`[bonus-eod-check ${new Date().toISOString()}] ${message}`);
}

// ── Pacific date helpers ────────────────────────────────────────────

const ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  weekday: 'short',
});

function pacificDateParts(now) {
  const iso = ISO_FMT.format(now);
  const label = LABEL_FMT.format(now);
  const weekday = WEEKDAY_FMT.format(now);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  const dayKeyUTC = new Date(Date.UTC(y, m - 1, d));
  return { iso, label, dayKeyUTC, isWeekend };
}

// Read the Pacific wall clock off a UTC instant — same technique as
// `src/lib/time.ts` and `scripts/bonus-period-close.mjs`, so "what time is it in
// Pacific" is DST-correct without hardcoding the -7/-8 offset.
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
 * Next UTC instant at which the Pacific wall clock reads 20:00:00 (FIRE_HOUR_PT:
 * FIRE_MINUTE_PT), strictly after `from`. DST-correct via the OFFSET-REPROBE
 * technique ported from `scripts/bonus-period-close.mjs` (`msUntilNext0700Pacific`):
 * resolve the target Pacific wall time on each candidate Pacific calendar day and
 * convert to a true UTC instant using the offset in effect ON THAT DAY.
 *
 * This replaces the earlier "delta seconds-of-day added to `from`" version, which
 * assumed every Pacific day is 86400s and so misfired across DST: it DOUBLE-FIRED
 * on fall-back (the 25h day — it landed 1h early, then the loop recomputed and
 * fired again at the real wall clock) and fired 1h LATE on spring-forward (the 23h
 * day).
 */
function nextFireInstant(from) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, FIRE_HOUR_PT, FIRE_MINUTE_PT, 0);
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    if (fireUtc.getTime() - from.getTime() > 1_000) return fireUtc;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000); // defensive fallback (should never hit)
}

// ── ntfy publish (fail-soft, primary→fallback) ──────────────────────

async function postWithTimeout(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function publishMissing({ siteCode, siteName, dateLabel, fingerprint }) {
  const token = process.env['NTFY_PUBLISHER_TOKEN']?.trim();
  // Title MUST NOT be prefixed with [DR3-Vision] — publishNtfy auto-prefixes
  // in TS-land; in the .mjs daemon we set the full title once because we're
  // calling ntfy HTTP directly. Keep "[DR3-Vision]" here so the user-visible
  // title matches the rest of the fleet.
  const title = `[DR3-Vision] No bonus entries for ${siteName}`.slice(0, 250);
  const body =
    `No bonus entries recorded for ${siteName} — ${dateLabel}. ` +
    `Nobody logged a bonus today. Open /bonus to enter.`;

  if (!token) {
    logTs(`NTFY_PUBLISHER_TOKEN unset — skipping publish for ${siteCode} (no-op)`);
    return;
  }

  const headers = {
    'X-Title': title,
    Priority: 'high',
    Click: CLICK_URL,
    Tags: 'warning,bonus,dr3-vision',
    'X-Dedup-Id': fingerprint,
    Authorization: `Bearer ${token}`,
  };
  const ok = await postWithTimeout(`${PRIMARY_BASE}/${TOPIC}`, body, headers, TIMEOUT_MS);
  if (ok) {
    logTs(`published to ${TOPIC} for ${siteCode} (${fingerprint})`);
    return;
  }
  const fbHeaders = {
    'X-Title': `[FALLBACK] ${title}`.slice(0, 250),
    Priority: 'high',
    Click: CLICK_URL,
    Tags: 'warning,bonus,dr3-vision',
    'X-Dedup-Id': fingerprint,
  };
  const fbOk = await postWithTimeout(
    `${FALLBACK_BASE}/${FALLBACK_TOPIC}`,
    body,
    fbHeaders,
    TIMEOUT_MS,
  );
  logTs(
    fbOk
      ? `published to FALLBACK topic for ${siteCode} (${fingerprint})`
      : `publish FAILED for ${siteCode} (${fingerprint})`,
  );
}

// ── Per-site check ──────────────────────────────────────────────────

async function checkSite(prisma, site, dateParts) {
  const holiday = await prisma.siteHoliday.findUnique({
    where: {
      site_id_holiday_date: { site_id: site.id, holiday_date: dateParts.dayKeyUTC },
    },
    select: { id: true },
  });
  if (holiday) {
    logTs(`${site.code}: site holiday on ${dateParts.iso} — skipping`);
    return;
  }

  const activeEmployees = await prisma.bonusEmployee.findMany({
    where: { site_id: site.id, is_active: true, deleted_at: null },
    select: { id: true },
  });
  if (activeEmployees.length === 0) {
    logTs(`${site.code}: no active employees — skipping`);
    return;
  }

  const entries = await prisma.bonusDailyEntry.findMany({
    where: {
      entry_date: dateParts.dayKeyUTC,
      bonus_employee: { site_id: site.id },
    },
    select: { bonus_employee_id: true },
  });
  const entered = new Set(entries.map((e) => e.bonus_employee_id));

  // Revised 2026-06-17 (ADR-0019 §2): page ONLY when the site has zero entries
  // for the day. A partial day (some processors entered, others off / on a
  // different position) is normal and never pages.
  if (entered.size > 0) {
    logTs(
      `${site.code}: ${entered.size} entr${entered.size === 1 ? 'y' : 'ies'} present — no alert`,
    );
    return;
  }

  logTs(`${site.code}: no bonus entries for ${dateParts.iso} — alerting`);
  await publishMissing({
    siteCode: site.code,
    siteName: site.name,
    dateLabel: dateParts.label,
    fingerprint: `bonus-entry-missing:${site.code}:${dateParts.iso}`,
  });
}

// ── Fire ─────────────────────────────────────────────────────────────

async function runOnce(prisma) {
  const now = new Date();
  const dateParts = pacificDateParts(now);
  logTs(`evaluating bi-site EOD for Pacific day ${dateParts.iso} (${dateParts.label})`);

  if (dateParts.isWeekend) {
    logTs('weekend — skipping all sites');
    return;
  }

  // Iterate every site that has an active bonus signature chain (a bonus-enabled site).
  const sites = await prisma.site.findMany({
    where: { bonus_signature_chain: { isNot: null } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  for (const site of sites) {
    try {
      await checkSite(prisma, site, dateParts);
    } catch (err) {
      logTs(`${site.code}: check FAILED — ${err?.message ?? err}`);
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────

async function main() {
  if (!process.env['DATABASE_URL']) {
    console.error('bonus-eod-check: DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  logTs('daemon starting');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = new Date();
    const fire = nextFireInstant(now);
    const sleepMs = fire.getTime() - now.getTime();
    logTs(`sleeping until ${fire.toISOString()} (~${Math.round(sleepMs / 1000)}s)`);
    await new Promise((res) => setTimeout(res, sleepMs));

    try {
      await runOnce(prisma);
    } catch (err) {
      logTs(`runOnce FAILED — ${err?.message ?? err}`);
    }
  }
}

// Only start the daemon when run as the entrypoint — keeps the module importable
// (for the schedule-helper test) without spawning timers or a DB client. Every
// sibling daemon uses this guard; bonus-eod-check previously auto-ran main() on
// import, which meant importing it under test would start the loop and exit(2)
// on the missing DATABASE_URL.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('bonus-eod-check: fatal', err);
    process.exit(1);
  });
}

export { nextFireInstant };
