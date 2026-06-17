#!/usr/bin/env node
// ADR-0019 §2 + ADR-0028 — Bi-site EOD bonus-entry enforcement (daemon).
//
// Long-running daemon, same shape as bonus-period-close + bonus-escalation-check:
// sleeps until the next 17:00 Pacific instant, fires, repeats. Per-site
// iteration covers Woodland + Eugene (any site with an active bonus signature
// chain). One ntfy per site with missing entries, fingerprinted per (site, date).

import { PrismaClient } from '@prisma/client';

const PACIFIC_TZ = 'America/Los_Angeles';
const FIRE_HOUR_PT = 17;
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

// Next 17:00 PT instant after `from`. Safe across DST shifts: we project `from`
// into Pacific wall-clock parts, compute the seconds-of-day delta to 17:00 PT,
// and add the delta in UTC. The Intl formatter does all the DST math for us.
function nextFireInstant(from) {
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
  const ptNow = {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
  const currentSecondsOfDay = ptNow.hour * 3600 + ptNow.minute * 60 + ptNow.second;
  const fireSecondsOfDay = FIRE_HOUR_PT * 3600 + FIRE_MINUTE_PT * 60;
  let deltaSec;
  if (currentSecondsOfDay < fireSecondsOfDay) {
    deltaSec = fireSecondsOfDay - currentSecondsOfDay;
  } else {
    deltaSec = 86400 - currentSecondsOfDay + fireSecondsOfDay;
  }
  return new Date(from.getTime() + deltaSec * 1000);
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

main().catch((err) => {
  console.error('bonus-eod-check: fatal', err);
  process.exit(1);
});
