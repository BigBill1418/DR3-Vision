// 2026-07-11 operator directive (Bill, verbatim intent): "even if a site does
// not get their bonus entered by the required time the report still goes out
// as soon as they hit save … the production data still has to get out to the
// team regardless of when it gets put in — there should just be a flag on
// there that says what time it was submitted."
//
// 2026-07-21 amendment (later-shift, ADR-0019 §2 / ADR-0030): the team now
// works a later shift and the entry deadline is 8:00 PM PT. The report is now
// PRIMARILY an ON-SAVE event: "the report goes out for each site as soon as the
// data is entered and saved." This path therefore fires on EVERY successful
// save — not only when the save is past the deadline. Lateness no longer GATES
// the send; it only sets the flag/banner (was the data entered after the 8pm
// deadline?). The ADR-0030 scheduled daemon (send_time_pt = 20:00 PT) is now a
// pure end-of-window BACKSTOP: whichever path claims the (site, report_date)
// log row first sends; the other finds the row and skips — the unique constraint
// makes a double-send impossible.
//
// This is the ON-SAVE report path, called (fail-soft) after every successful
// daily-entry write. Semantics:
//
//   - The report goes out IMMEDIATELY on save. If the save is past the site's
//     Pacific deadline (send_time_pt = the 8pm cutoff; a prior calendar day is
//     always past), the report is flagged LATE with the submission instant
//     (banner + subject suffix). An on-time save sends the SAME report the
//     scheduled fire would have, with no late framing.
//   - Weekend/holiday skips do NOT apply here: those gate the *scheduled* fire;
//     data someone entered means work happened, and the directive is
//     "regardless of when it gets put in".
//   - Idempotent per content: a save that leaves the day's totals unchanged
//     from the last send is a no-op (so repeated saves of the same numbers
//     never spam). A save that CHANGES the totals after a report already went
//     out re-sends with "supersedes the earlier send" and bumps resend_count —
//     the team always ends the day holding the real numbers.
//   - A zero-total day never sends from this path (nothing to report;
//     skip_if_zero stays the scheduled path's business, and the EOD daemon
//     pages the zero-entry site separately at 20:00 PT).
//   - FAIL-SOFT by contract: this function never throws — a mail failure must
//     never fail the manager's save. Failures log loud and the next save (or
//     tomorrow's operator eyeball of the log table) retries naturally.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appToday, formatPacificDateTime } from '@/lib/time';
import { log } from '@/lib/observability/logger';
import { buildDailyReport } from './daily-report';
import { sendDailyReport } from './daily-report-notifications';
import { pacificSecondsOfDay, sendTimeSecondsOfDay } from './daily-report-runner';

/** True for a Prisma P2002 unique-constraint violation (the claim-lost signal). */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export type OnSaveReportOutcome =
  | 'sent' // on-time on-save send (no late framing)
  | 'resent' // on-time re-send superseding an earlier same-day send
  | 'sent_late' // first send, entered after the 8pm deadline
  | 'resent_late' // re-send after the deadline, superseding an earlier send
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
 * Fire the day's production report NOW, on save (ADR-0019 §2 amendment
 * 2026-07-21: "the report goes out for each site as soon as the data is entered
 * and saved"). The report is sent immediately regardless of the time of day;
 * lateness (`isPastScheduledSend` against the 8pm deadline) only decides whether
 * the report carries the LATE banner/flag. Never throws (fail-soft — see module
 * header): a send failure must never fail the manager's save.
 */
export async function maybeSendDailyReportOnSave(
  siteId: string,
  entryDay: Date,
  now: Date = new Date(),
): Promise<OnSaveReportOutcome> {
  try {
    const cfg = await prisma.bonusDailyReportConfig.findFirst({
      where: { site_id: siteId, enabled: true },
      include: { recipients: { select: { email: true } } },
    });
    if (!cfg) return 'skipped_no_config';

    // Never report a day that has not happened yet. Unlike lateness, this is a
    // hard skip — a future @db.Date key is a mis-call, not an on-time save.
    if (entryDay.getTime() > appToday(now).getTime()) return 'skipped_future';

    // Lateness no longer GATES the send (was: `if (!isPastScheduledSend) return
    // 'not_late'`). It only flags the report: true when the save landed after
    // the 8pm deadline (send_time_pt) or on a prior calendar day.
    const late = isPastScheduledSend(entryDay, cfg.send_time_pt, now);

    const recipients = cfg.recipients.map((r) => r.email);
    if (recipients.length === 0) {
      log.warn(
        { site_id: siteId, report_date: entryDay.toISOString().slice(0, 10) },
        '[daily-report] on-save report but no recipients configured',
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
    // CLAIM-BEFORE-SEND (M1): win the (site_id, report_date) send slot BEFORE the
    // Graph send, so a double-click, a re-save, or a race with the scheduled fire
    // (both paths share this log table) can never each send and duplicate the
    // production report to the team.
    //  - No prior row → `create` is the claim; a concurrent claim throws P2002.
    //  - Prior row with CHANGED totals → a CAS `updateMany` guarded on the stored
    //    totals still differing wins the resend exactly once; a duplicate resend of
    //    the same new totals matches nothing (count 0).
    // Either lost claim bails WITHOUT sending. The delivery columns are finalized
    // after the send below.
    const claimData = {
      recipient_count: recipients.length,
      total_today: report.totalToday,
      total_bonus_cents: report.totalBonusCents,
      mtd_total: report.mtd.total ?? 0,
      delivered_count: 0, // finalized post-send
      late_submission: late,
      data_entered_at: now,
      sent_at: now,
    };
    let logId: string;
    if (existing) {
      const claim = await prisma.bonusDailyReportLog.updateMany({
        where: {
          id: existing.id,
          NOT: { total_today: report.totalToday, total_bonus_cents: report.totalBonusCents },
        },
        data: { ...claimData, resend_count: { increment: 1 } },
      });
      if (claim.count === 0) return 'skipped_unchanged'; // lost the resend race
      logId = existing.id;
    } else {
      try {
        const claimed = await prisma.bonusDailyReportLog.create({
          data: { site_id: siteId, report_date: entryDay, ...claimData },
          select: { id: true },
        });
        logId = claimed.id;
      } catch (e) {
        if (isUniqueViolation(e)) return 'skipped_unchanged'; // lost the first-send race
        throw e;
      }
    }

    const send = await sendDailyReport({
      report,
      recipients,
      subjectTemplate: cfg.subject_template,
      includeBonusDollars: cfg.include_bonus_dollars,
      includeComparisons: cfg.include_comparisons,
      // Only an after-deadline save carries the LATE banner/subject. An on-time
      // on-save send is the SAME report the scheduled fire would have produced.
      // A same-day resend of changed totals still gets the banner iff late.
      ...(late
        ? {
            lateInfo: {
              enteredAtPT: `${formatPacificDateTime(now)} PT`,
              scheduledPT: formatSendTimePt(cfg.send_time_pt),
              isResend,
            },
          }
        : {}),
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

    log.info(
      {
        op: 'daily-report.on-save',
        site_id: siteId,
        report_date: entryDay.toISOString().slice(0, 10),
        total_today: report.totalToday,
        delivered: send.delivered_count,
        resend: isResend,
        late,
      },
      '[daily-report] production report sent on save',
    );
    const verb = isResend ? 'resent' : 'sent';
    return late ? (`${verb}_late` as const) : verb;
  } catch (err) {
    // Fail-soft contract: the save that triggered us already committed.
    log.error(
      { err, site_id: siteId, report_date: entryDay.toISOString().slice(0, 10) },
      '[daily-report] late-entry send failed (save unaffected)',
    );
    return 'error';
  }
}
