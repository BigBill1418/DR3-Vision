// 2026-07-11 operator directive (Bill, verbatim intent): "even if a site does
// not get their bonus entered by the required time the report still goes out
// as soon as they hit save … the production data still has to get out to the
// team regardless of when it gets put in — there should just be a flag on
// there that says what time it was submitted."
//
// This is the ON-SAVE late path, called (fail-soft) after every successful
// daily-entry write. Semantics:
//
//   - LATE means the entry's report day is past its site's scheduled Pacific
//     send time (a prior calendar day is always late). An on-time save does
//     nothing — the ADR-0030 scheduled fire owns the normal case.
//   - The report goes out IMMEDIATELY on save, flagged with the submission
//     instant (banner + subject suffix). Weekend/holiday skips do NOT apply
//     here: those gate the *scheduled* fire; data someone entered means work
//     happened, and the directive is "regardless of when it gets put in".
//   - Idempotent per content: a save that leaves the day's totals unchanged
//     from the last send is a no-op (so repeated saves of the same numbers
//     never spam). A save that CHANGES the totals after a report already went
//     out re-sends with "supersedes the earlier send" and bumps resend_count —
//     the team always ends the day holding the real numbers.
//   - A zero-total day never sends from this path (nothing to report;
//     skip_if_zero stays the scheduled path's business).
//   - FAIL-SOFT by contract: this function never throws — a mail failure must
//     never fail the manager's save. Failures log loud and the next save (or
//     tomorrow's operator eyeball of the log table) retries naturally.

import { prisma } from '@/lib/prisma';
import { appToday, formatPacificDateTime } from '@/lib/time';
import { log } from '@/lib/observability/logger';
import { buildDailyReport } from './daily-report';
import { sendDailyReport } from './daily-report-notifications';
import { pacificSecondsOfDay, sendTimeSecondsOfDay } from './daily-report-runner';

export type LateReportOutcome =
  | 'sent_late'
  | 'resent_late'
  | 'not_late'
  | 'skipped_no_config'
  | 'skipped_no_recipients'
  | 'skipped_zero'
  | 'skipped_unchanged'
  | 'skipped_future'
  | 'error';

/** "6:00 PM PT" from a @db.Time value (UTC components ARE the wall clock). */
export function formatSendTimePt(sendTimePt: Date): string {
  const h24 = sendTimePt.getUTCHours();
  const m = sendTimePt.getUTCMinutes();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm} PT`;
}

/**
 * True when `entryDay` (a @db.Date key) is past its scheduled send at `now`:
 * any prior Pacific calendar day, or today once the send time has passed.
 */
export function isPastScheduledSend(entryDay: Date, sendTimePt: Date, now: Date): boolean {
  const today = appToday(now);
  if (entryDay.getTime() < today.getTime()) return true;
  if (entryDay.getTime() > today.getTime()) return false;
  return pacificSecondsOfDay(now) >= sendTimeSecondsOfDay(sendTimePt);
}

/**
 * Fire the day's production report NOW if the just-saved data arrived after
 * the scheduled send. Never throws (fail-soft — see module header).
 */
export async function maybeSendLateDailyReport(
  siteId: string,
  entryDay: Date,
  now: Date = new Date(),
): Promise<LateReportOutcome> {
  try {
    const cfg = await prisma.bonusDailyReportConfig.findFirst({
      where: { site_id: siteId, enabled: true },
      include: { recipients: { select: { email: true } } },
    });
    if (!cfg) return 'skipped_no_config';

    if (entryDay.getTime() > appToday(now).getTime()) return 'skipped_future';
    if (!isPastScheduledSend(entryDay, cfg.send_time_pt, now)) return 'not_late';

    const recipients = cfg.recipients.map((r) => r.email);
    if (recipients.length === 0) {
      log.warn(
        { site_id: siteId, report_date: entryDay.toISOString().slice(0, 10) },
        '[daily-report] late save but no recipients configured',
      );
      return 'skipped_no_recipients';
    }

    const report = await buildDailyReport(siteId, entryDay);
    if (report.totalToday === 0) return 'skipped_zero';

    const existing = await prisma.bonusDailyReportLog.findUnique({
      where: { site_id_report_date: { site_id: siteId, report_date: entryDay } },
    });
    if (
      existing &&
      existing.total_today === report.totalToday &&
      existing.total_bonus_cents === report.totalBonusCents
    ) {
      return 'skipped_unchanged';
    }

    const isResend = existing != null;
    const send = await sendDailyReport({
      report,
      recipients,
      subjectTemplate: cfg.subject_template,
      includeBonusDollars: cfg.include_bonus_dollars,
      includeComparisons: cfg.include_comparisons,
      lateInfo: {
        enteredAtPT: `${formatPacificDateTime(now)} PT`,
        scheduledPT: formatSendTimePt(cfg.send_time_pt),
        isResend,
      },
    });

    const data = {
      recipient_count: send.attempted,
      total_today: report.totalToday,
      total_bonus_cents: report.totalBonusCents,
      mtd_total: report.mtd.total ?? 0,
      delivered_count: send.delivered_count,
      graph_message_id: send.graph_message_id ?? null,
      last_status: send.last_status ?? null,
      late_submission: true,
      data_entered_at: now,
      sent_at: now,
    };
    if (existing) {
      await prisma.bonusDailyReportLog.update({
        where: { id: existing.id },
        data: { ...data, resend_count: existing.resend_count + 1 },
      });
    } else {
      await prisma.bonusDailyReportLog.create({
        data: { site_id: siteId, report_date: entryDay, ...data },
      });
    }

    log.info(
      {
        op: 'daily-report.late-send',
        site_id: siteId,
        report_date: entryDay.toISOString().slice(0, 10),
        total_today: report.totalToday,
        delivered: send.delivered_count,
        resend: isResend,
      },
      '[daily-report] late-entry report sent on save',
    );
    return isResend ? 'resent_late' : 'sent_late';
  } catch (err) {
    // Fail-soft contract: the save that triggered us already committed.
    log.error(
      { err, site_id: siteId, report_date: entryDay.toISOString().slice(0, 10) },
      '[daily-report] late-entry send failed (save unaffected)',
    );
    return 'error';
  }
}
