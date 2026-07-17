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

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { buildDailyReport } from '@/lib/bonus/daily-report';
import { sendDailyReport } from '@/lib/bonus/daily-report-notifications';
import { appToday } from '@/lib/time';
import { log } from '@/lib/observability/logger';

/** True for a Prisma P2002 unique-constraint violation (the claim-lost signal). */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

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
 * True iff a @db.Date-shaped day key (UTC-midnight of a calendar day) is a
 * weekend. The backfill weekend gate must target the REPORT day, not the run
 * instant: a @db.Date carries no wall-clock, so its weekday is read in UTC —
 * reinterpreting that instant in Pacific would land on the prior calendar day.
 */
function isDayKeyWeekend(dayKey: Date): boolean {
  const wd = dayKey.getUTCDay(); // 0 = Sunday … 6 = Saturday
  return wd === 0 || wd === 6;
}

/**
 * Seconds-of-day of a `@db.Time` value. Prisma round-trips a TIME column as a
 * Date whose UTC hours/minutes ARE the configured wall-clock (no zone), so we
 * read it with getUTCHours/getUTCMinutes — same as the daemon's `hmFromTime`.
 */
export function sendTimeSecondsOfDay(sendTimePt: Date): number {
  return sendTimePt.getUTCHours() * 3600 + sendTimePt.getUTCMinutes() * 60;
}

export interface FireOptions {
  /**
   * Explicit Pacific target day as a @db.Date-shaped key (UTC-midnight of the
   * calendar day). When set, this becomes the `dayKey` DIRECTLY (it is NOT run
   * through `appToday`) and the "not due yet" send-time gate is BYPASSED — a
   * past day is always due. Every other guard (weekend/holiday/skip_if_zero/
   * idempotency/recipients) still applies. This is the BACKFILL path: a missed
   * day re-sent to the real roster, with the REAL (non-`[TEST]`) subject and a
   * `bonus_daily_report_log` row written. The scheduled path passes no `forDate`
   * and behaves identically to before.
   */
  forDate?: Date | undefined;
  /** Restrict the fire to these site codes (e.g. `['woodland','eugene']`). */
  siteCodes?: string[] | undefined;
  /**
   * Re-send + re-finalize even when a `(site, report_date)` log row already
   * exists (reuses the existing row — the unique constraint forbids a second).
   * Without this, an already-logged day is `skipped_already_logged`.
   */
  force?: boolean | undefined;
}

export async function runDailyReportFire(
  now: Date = new Date(),
  opts: FireOptions = {},
): Promise<{ outcomes: FireOutcome[] }> {
  const backfill = opts.forDate !== undefined;
  const force = opts.force === true;
  // A `forDate` is already a @db.Date-shaped key (UTC-midnight of the Pacific
  // calendar day) — use it as the day key directly. Only the scheduled path
  // derives the key from the run instant.
  const dayKey = opts.forDate ?? appToday(now);
  const nowSecondsOfDay = pacificSecondsOfDay(now);
  // The weekend gate targets the REPORT day: for a backfill that is the day key
  // (read in UTC); for the scheduled path it is the Pacific weekday of `now`.
  const weekend = backfill ? isDayKeyWeekend(dayKey) : isPacificWeekend(now);

  const configs = (
    await prisma.bonusDailyReportConfig.findMany({
      where: { enabled: true },
      include: {
        site: { select: { id: true, code: true, name: true } },
        recipients: { select: { email: true } },
      },
    })
  ).filter((cfg) => !opts.siteCodes || opts.siteCodes.includes(cfg.site.code));

  const outcomes: FireOutcome[] = [];

  for (const cfg of configs) {
    const siteCode = cfg.site.code;
    try {
      // DUE check: the daemon wakes for the soonest send time; fire only the
      // sites whose Pacific send time has already passed. A backfill (`forDate`)
      // targets a past day that is unconditionally due, so this gate is skipped.
      if (!backfill && nowSecondsOfDay < sendTimeSecondsOfDay(cfg.send_time_pt)) {
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
      if (existing && !force) {
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

      // CLAIM-BEFORE-SEND (M1): the unique (site_id, report_date) makes this create
      // the atomic gate. The findUnique above is only a cheap fast-path; without a
      // claim, a concurrent scheduled fire OR an on-save late send (both share this
      // log table) could each pass their read-check and BOTH send, mailing the team
      // a duplicate production report. Claim first: a losing writer's create throws
      // P2002 → bail without sending. Delivery columns are finalized after the send.
      //
      // FORCE (backfill re-send): a row already exists (the non-force branch above
      // already returned). Reuse it — the unique constraint forbids a second row —
      // and re-finalize its delivery columns after the send.
      let logId: string;
      if (existing) {
        logId = existing.id; // force === true here
      } else {
        try {
          const claimed = await prisma.bonusDailyReportLog.create({
            data: {
              site_id: cfg.site_id,
              report_date: dayKey,
              recipient_count: recipients.length,
              total_today: report.totalToday,
              total_bonus_cents: report.totalBonusCents,
              mtd_total: report.mtd.total ?? 0,
              delivered_count: 0, // finalized post-send
            },
            select: { id: true },
          });
          logId = claimed.id;
        } catch (e) {
          if (isUniqueViolation(e)) {
            // A concurrent writer claimed between our read and create. Under
            // force, reuse that row and re-send; otherwise this is the M1
            // duplicate-guard → bail without sending.
            if (!force) {
              outcomes.push({ siteCode, status: 'skipped_already_logged' });
              continue;
            }
            const raced = await prisma.bonusDailyReportLog.findUnique({
              where: { site_id_report_date: { site_id: cfg.site_id, report_date: dayKey } },
              select: { id: true },
            });
            if (!raced) {
              outcomes.push({ siteCode, status: 'skipped_already_logged' });
              continue;
            }
            logId = raced.id;
          } else {
            throw e;
          }
        }
      }

      const send = await sendDailyReport({
        report,
        recipients,
        subjectTemplate: cfg.subject_template,
        includeBonusDollars: cfg.include_bonus_dollars,
        includeComparisons: cfg.include_comparisons,
      });

      // Finalize the claimed row with the delivery outcome.
      await prisma.bonusDailyReportLog.update({
        where: { id: logId },
        data: {
          recipient_count: send.attempted,
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
