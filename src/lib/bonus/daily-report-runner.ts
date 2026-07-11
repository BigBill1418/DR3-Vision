// ADR-0030 — Daily production report orchestration (the testable core).
//
// This is the work the thin Pacific scheduler (`scripts/bonus-daily-report.mjs`)
// triggers by POSTing the internal route. The .mjs daemon stays plain JS (no
// tsx, no TS import) because the prod image is `npm ci --omit=dev` and tsx is a
// devDependency (BUILD-CONTRACT divergence #1). All real work runs compiled
// inside the Next app, here.
//
// `runDailyReportFire(now)` iterates every enabled config and, per site:
//   - DUE check: only fire sites whose Pacific send time has already passed
//     when the daemon woke for the soonest one. The route fires *whichever*
//     sites are due, idempotently, so a slightly-early/late POST is safe.
//   - skip_weekends / skip_holidays gates (Pacific calendar day).
//   - idempotency via the bonus_daily_report_log unique (site, report_date).
//   - skip_if_zero (the EOD daemon already paged on a zero day).
//   - build → send → write the log row.
//
// Per-site work is wrapped in try/catch: one site throwing never stops the
// others and never throws out of this function (the route stays 200).

import { prisma } from '@/lib/prisma';
import { buildDailyReport } from '@/lib/bonus/daily-report';
import { sendDailyReport } from '@/lib/bonus/daily-report-notifications';
import { appToday } from '@/lib/time';
import { log } from '@/lib/observability/logger';

export interface FireOutcome {
  siteCode: string;
  status:
    | 'sent'
    | 'skipped_not_due'
    | 'skipped_weekend'
    | 'skipped_holiday'
    | 'skipped_already_logged'
    | 'skipped_zero'
    | 'skipped_no_recipients';
  delivered?: number;
  attempted?: number;
}

const PACIFIC_TZ = 'America/Los_Angeles';

// Pacific wall-clock parts for an instant — mirrors handoff part-2 §8
// (`pacificDateParts`) and `src/lib/time.ts`. Inlined here (rather than imported)
// so the due-check uses the same DST-correct Intl path as the daemon.
const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const PACIFIC_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  weekday: 'short',
});

/** Pacific seconds-of-day for an instant (0..86399), DST-correct. */
export function pacificSecondsOfDay(now: Date): number {
  const parts = Object.fromEntries(
    PACIFIC_PARTS_FMT.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return Number(parts['hour']) * 3600 + Number(parts['minute']) * 60 + Number(parts['second']);
}

/** True iff the Pacific calendar day of `now` is Saturday or Sunday. */
function isPacificWeekend(now: Date): boolean {
  const wd = PACIFIC_WEEKDAY_FMT.format(now);
  return wd === 'Sat' || wd === 'Sun';
}

/**
 * Seconds-of-day of a `@db.Time` value. Prisma round-trips a TIME column as a
 * Date whose UTC hours/minutes ARE the configured wall-clock (no zone), so we
 * read it with getUTCHours/getUTCMinutes — same as the daemon's `hmFromTime`.
 */
export function sendTimeSecondsOfDay(sendTimePt: Date): number {
  return sendTimePt.getUTCHours() * 3600 + sendTimePt.getUTCMinutes() * 60;
}

export async function runDailyReportFire(
  now: Date = new Date(),
): Promise<{ outcomes: FireOutcome[] }> {
  const dayKey = appToday(now);
  const nowSecondsOfDay = pacificSecondsOfDay(now);
  const weekend = isPacificWeekend(now);

  const configs = await prisma.bonusDailyReportConfig.findMany({
    where: { enabled: true },
    include: {
      site: { select: { id: true, code: true, name: true } },
      recipients: { select: { email: true } },
    },
  });

  const outcomes: FireOutcome[] = [];

  for (const cfg of configs) {
    const siteCode = cfg.site.code;
    try {
      // DUE check: the daemon wakes for the soonest send time; fire only the
      // sites whose Pacific send time has already passed.
      if (nowSecondsOfDay < sendTimeSecondsOfDay(cfg.send_time_pt)) {
        outcomes.push({ siteCode, status: 'skipped_not_due' });
        continue;
      }
      if (cfg.skip_weekends && weekend) {
        outcomes.push({ siteCode, status: 'skipped_weekend' });
        continue;
      }
      if (cfg.skip_holidays) {
        const holiday = await prisma.siteHoliday.findUnique({
          where: { site_id_holiday_date: { site_id: cfg.site_id, holiday_date: dayKey } },
          select: { id: true },
        });
        if (holiday) {
          outcomes.push({ siteCode, status: 'skipped_holiday' });
          continue;
        }
      }

      const existing = await prisma.bonusDailyReportLog.findUnique({
        where: { site_id_report_date: { site_id: cfg.site_id, report_date: dayKey } },
        select: { id: true },
      });
      if (existing) {
        outcomes.push({ siteCode, status: 'skipped_already_logged' });
        continue;
      }

      const report = await buildDailyReport(cfg.site_id, dayKey);
      if (cfg.skip_if_zero && report.totalToday === 0) {
        outcomes.push({ siteCode, status: 'skipped_zero' });
        continue;
      }

      const recipients = cfg.recipients.map((r) => r.email);
      if (recipients.length === 0) {
        outcomes.push({ siteCode, status: 'skipped_no_recipients' });
        continue;
      }

      const send = await sendDailyReport({
        report,
        recipients,
        subjectTemplate: cfg.subject_template,
        includeBonusDollars: cfg.include_bonus_dollars,
        includeComparisons: cfg.include_comparisons,
      });

      await prisma.bonusDailyReportLog.create({
        data: {
          site_id: cfg.site_id,
          report_date: dayKey,
          recipient_count: send.attempted,
          total_today: report.totalToday,
          total_bonus_cents: report.totalBonusCents,
          mtd_total: report.mtd.total ?? 0,
          delivered_count: send.delivered_count,
          graph_message_id: send.graph_message_id ?? null,
          last_status: send.last_status ?? null,
        },
      });

      outcomes.push({
        siteCode,
        status: 'sent',
        delivered: send.delivered_count,
        attempted: send.attempted,
      });
    } catch (err) {
      log.error({ err, siteCode }, '[daily-report] site fire failed (non-fatal)');
      // Continue with the other sites; never throw out of the fire.
    }
  }

  return { outcomes };
}
