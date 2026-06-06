#!/usr/bin/env node
// T-113 — EOD bonus-entry enforcement (ADR-0019 §2).
//
// Cron registration (deployer cron, NOT a system crontab):
//   Schedule: 0 17 * * *  in TZ=America/Los_Angeles  (5:00 PM Pacific,
//   daily). The fleet runs one-shot scripts like this via the deployer's
//   cron surface — this file is the executable; wiring the schedule is an
//   operator/deployer config step (mirrors how `mymrc-cron.mjs` is hosted,
//   except this one is a single-shot run, not a long-lived loop).
//
//   The 5 PM Pacific anchor is deliberate: the box clock is UTC (7–8h
//   ahead of Bill), so "today" must be resolved in America/Los_Angeles or
//   the alert date is off by one. See `src/lib/bonus/eod-check.ts` for the
//   tested date math this script mirrors.
//
// Behaviour:
//   1. Resolve TODAY as the Pacific calendar day of the run instant.
//   2. Skip silently on weekends and on Woodland `site_holidays`.
//   3. Load active Woodland `bonus_employees` and the set of employee ids
//      that already have a `bonus_daily_entries` row for today.
//   4. If ANY active employee is missing an entry, publish ONE ntfy alert
//      to `dr3-vision-system` with fingerprint
//      `bonus-entry-missing:woodland:<YYYY-MM-DD>`.
//
// Fire-once / no-un-send: the fingerprint is keyed on the Pacific day and
// the cron runs once/day, so the alert fires at most once. A late entry the
// next morning lands under a different day's fingerprint and can never
// suppress (un-send) the prior day's alert. This is strict by design.
//
// Fail-soft on ntfy: when `NTFY_PUBLISHER_TOKEN` is unset the publish step
// is a no-op (the script still exits 0). On primary failure it retries once
// on the public ntfy.sh fallback topic with `[FALLBACK]` prefixed and the
// Authorization header stripped (ADR-0036 / ADR-0037), mirroring
// `migrate-with-ntfy.mjs` and `src/lib/ntfy.ts`.

import { PrismaClient } from '@prisma/client';

const SITE_CODE = 'woodland';
const PACIFIC_TZ = 'America/Los_Angeles';

const PRIMARY_BASE = process.env['NTFY_BASE_URL']?.trim() || 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';
const TOPIC = process.env['NTFY_TOPIC_SYSTEM']?.trim() || 'dr3-vision-system';
// Pinned obscured fallback topic for `dr3-vision-system` — matches
// `src/lib/ntfy.ts#FALLBACK_TOPIC_BY_PRIMARY` and ntfy-fallback-topics.yml.
const FALLBACK_TOPIC = 'bhq-fb-dr3v-system-k8m2n';
const CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const TIMEOUT_MS = 5_000;

function logTs(message) {
  console.log(`[bonus-eod-check ${new Date().toISOString()}] ${message}`);
}

// ── Pacific-day resolution (mirrors src/lib/bonus/eod-check.ts) ───────

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
  const iso = ISO_FMT.format(now); // 'YYYY-MM-DD'
  const label = LABEL_FMT.format(now); // 'Sep 14, 2026'
  const weekday = WEEKDAY_FMT.format(now); // 'Mon'..'Sun'
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  // UTC-midnight key from the Pacific Y/M/D — matches @db.Date storage.
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  const dayKeyUTC = new Date(Date.UTC(y, m - 1, d));
  return { iso, label, dayKeyUTC, isWeekend };
}

function missingFingerprint(dateIso) {
  return `bonus-entry-missing:${SITE_CODE}:${dateIso}`;
}

// ── ntfy publish (fail-soft, primary→fallback) ───────────────────────

async function postWithTimeout(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    if (!resp.ok) {
      await resp.text().catch(() => '');
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function publishMissing({ dateLabel, missingCount, fingerprint }) {
  const token = process.env['NTFY_PUBLISHER_TOKEN']?.trim();
  const title = `[DR3-Vision] Bonus entries missing for Woodland`.slice(0, 250);
  const body =
    `Bonus entries missing for Woodland — ${dateLabel}. ` +
    `${missingCount} processor${missingCount === 1 ? '' : 's'} without an entry. ` +
    `Open /bonus to enter.`;

  if (!token) {
    logTs('NTFY_PUBLISHER_TOKEN unset — skipping publish (no-op, exit 0)');
    return;
  }

  const headers = {
    'X-Title': title,
    Priority: 'high',
    Click: CLICK_URL,
    Tags: 'warning,bonus,dr3-vision',
    // ntfy server-side dedup hint; the day-scoped fingerprint also makes
    // re-runs idempotent within the cooldown window.
    'X-Dedup-Id': fingerprint,
    Authorization: `Bearer ${token}`,
  };
  const ok = await postWithTimeout(`${PRIMARY_BASE}/${TOPIC}`, body, headers, TIMEOUT_MS);
  if (ok) {
    logTs(`published to ${TOPIC} (${fingerprint})`);
    return;
  }
  // Fallback — strip Authorization, prefix [FALLBACK]. No cooldown on the
  // fallback path (ADR-0037 §3 carve-out).
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
  logTs(fbOk ? `published to FALLBACK topic (${fingerprint})` : `publish FAILED (${fingerprint})`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env['DATABASE_URL']) {
    console.error('bonus-eod-check: DATABASE_URL is required');
    process.exit(2);
  }

  const now = new Date();
  const parts = pacificDateParts(now);
  logTs(`evaluating Woodland for Pacific day ${parts.iso} (${parts.label})`);

  if (parts.isWeekend) {
    logTs('weekend — skipping');
    return;
  }

  const prisma = new PrismaClient();
  try {
    const site = await prisma.site.findUnique({
      where: { code: SITE_CODE },
      select: { id: true },
    });
    if (!site) {
      console.error(`bonus-eod-check: no site with code ${SITE_CODE}`);
      process.exit(1);
    }

    const holiday = await prisma.siteHoliday.findUnique({
      where: { site_id_holiday_date: { site_id: site.id, holiday_date: parts.dayKeyUTC } },
      select: { id: true },
    });
    if (holiday) {
      logTs(`site holiday on ${parts.iso} — skipping`);
      return;
    }

    const activeEmployees = await prisma.bonusEmployee.findMany({
      where: { site_id: site.id, is_active: true, deleted_at: null },
      select: { id: true },
    });
    if (activeEmployees.length === 0) {
      logTs('no active employees — nothing to miss, skipping');
      return;
    }

    const entries = await prisma.bonusDailyEntry.findMany({
      where: {
        entry_date: parts.dayKeyUTC,
        bonus_employee: { site_id: site.id },
      },
      select: { bonus_employee_id: true },
    });
    const entered = new Set(entries.map((e) => e.bonus_employee_id));

    const missing = activeEmployees.filter((e) => !entered.has(e.id));
    if (missing.length === 0) {
      logTs(`all ${activeEmployees.length} active employees have entries — no alert`);
      return;
    }

    logTs(`${missing.length}/${activeEmployees.length} active employees missing entries — alerting`);
    await publishMissing({
      dateLabel: parts.label,
      missingCount: missing.length,
      fingerprint: missingFingerprint(parts.iso),
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('bonus-eod-check: fatal', err);
  process.exit(1);
});
