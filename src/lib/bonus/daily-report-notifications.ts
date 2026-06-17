// ADR-0030 — Render + send the daily production email.
//
// Subject from the config's subject_template ({site} and {date} substituted).
// HTML body uses the new "DR3 - {Site} Automated Production Report" header.
// Per-recipient send so one bad address never blocks the others. Never throws.

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import { formatCents } from '@/lib/bonus/calculator';
import type { DailyReport, ComparisonTotal } from '@/lib/bonus/daily-report';

// ─────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────

const FULL_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function fmtFull(d: Date): string {
  return FULL_DATE.format(d);
}
function fmtShort(d: Date): string {
  return SHORT_DATE.format(d);
}
function fmtRange(start: Date, end: Date): string {
  return `${MONTH_DAY.format(start)} – ${MONTH_DAY.format(end)}, ${end.getUTCFullYear()}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function comparisonLineHtml(label: string, c: ComparisonTotal): string {
  if (c.total === null) {
    return `${escapeHtml(label)}: <em>no previous data available</em>`;
  }
  return `${escapeHtml(label)}: <strong>${c.total.toLocaleString('en-US')}</strong> units`;
}

// ─────────────────────────────────────────────────────────────────────
// Subject
// ─────────────────────────────────────────────────────────────────────

export function renderSubject(report: DailyReport, template: string): string {
  return template.replace('{site}', report.siteName).replace('{date}', fmtShort(report.reportDate));
}

// ─────────────────────────────────────────────────────────────────────
// HTML body
// ─────────────────────────────────────────────────────────────────────

export interface RenderOptions {
  includeBonusDollars: boolean;
  includeComparisons: boolean;
}

export function renderHtmlBody(report: DailyReport, opts: RenderOptions): string {
  const headerLine = `DR3 - ${report.siteName} Automated Production Report`;

  const showBonus = opts.includeBonusDollars;

  const rows = report.lines
    .map((l) => {
      const name = escapeHtml(l.fullName);
      if (showBonus) {
        return `<tr><td style="padding:4px 0">${name}</td><td style="padding:4px 12px 4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${l.mattresses}</strong></td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${formatCents(l.bonusCents)}</td></tr>`;
      }
      return `<tr><td style="padding:4px 0">${name}</td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${l.mattresses}</strong></td></tr>`;
    })
    .join('\n');

  const headerRow = showBonus
    ? `<tr style="border-bottom:0.5px solid #ccc"><th style="text-align:left;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Processor</th><th style="text-align:right;padding:6px 12px 6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Units</th><th style="text-align:right;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Bonus</th></tr>`
    : `<tr style="border-bottom:0.5px solid #ccc"><th style="text-align:left;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Processor</th><th style="text-align:right;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Units</th></tr>`;

  const footerRow = showBonus
    ? `<tr style="border-top:0.5px solid #999;font-weight:500"><td style="padding:8px 0">Total Processed Today</td><td style="padding:8px 12px 8px 0;text-align:right;font-variant-numeric:tabular-nums">${report.totalToday.toLocaleString('en-US')}</td><td style="padding:8px 0;text-align:right;font-variant-numeric:tabular-nums">${formatCents(report.totalBonusCents)}</td></tr>`
    : `<tr style="border-top:0.5px solid #999;font-weight:500"><td style="padding:8px 0">Total Processed Today</td><td style="padding:8px 0;text-align:right;font-variant-numeric:tabular-nums">${report.totalToday.toLocaleString('en-US')}</td></tr>`;

  let comparisonBlock = '';
  if (opts.includeComparisons) {
    const paceLine = (() => {
      if (report.paceDeltaPct === null) {
        return `Pace vs. last month: <em>no comparable history</em>`;
      }
      const sign = report.paceDeltaPct >= 0 ? '+' : '';
      const arrow = report.paceDeltaPct >= 0 ? '▲' : '▼';
      const color = report.paceDeltaPct >= 0 ? '#3B6D11' : '#A32D2D';
      return `Pace vs. last month: <strong style="color:${color}">${sign}${report.paceDeltaPct.toFixed(1)}% ${arrow}</strong>`;
    })();
    comparisonBlock = `
  <hr style="border:none;border-top:0.5px solid #ccc;margin:16px 0" />
  <div style="font-size:14px;line-height:1.8">
    <div>${comparisonLineHtml(`Same day last year (${fmtShort(report.sameDayLastYear.startDate)})`, report.sameDayLastYear)}</div>
    <div>${comparisonLineHtml(`Month-to-date (${fmtRange(report.mtd.startDate, report.mtd.endDate)})`, report.mtd)}</div>
    <div>${comparisonLineHtml(`Same period last month (${fmtRange(report.priorMonthSamePeriod.startDate, report.priorMonthSamePeriod.endDate)})`, report.priorMonthSamePeriod)}</div>
    <div>${paceLine}</div>
  </div>`;
  }

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:640px">
  <h2 style="margin:0 0 4px;font-size:18px;font-weight:500">${escapeHtml(headerLine)}</h2>
  <p style="margin:0 0 16px;color:#666;font-size:13px">${escapeHtml(fmtFull(report.reportDate))}</p>
  <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px">
    <thead>${headerRow}</thead>
    <tbody>${rows}</tbody>
    <tfoot>${footerRow}</tfoot>
  </table>${comparisonBlock}
  <p style="color:#999;font-size:12px;margin:20px 0 0">—DR3-Vision (sent automatically; replaces manual report)</p>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────────────

export interface SendDailyReportArgs {
  report: DailyReport;
  recipients: readonly string[];
  subjectTemplate: string;
  includeBonusDollars: boolean;
  includeComparisons: boolean;
}

export interface SendDailyReportResult {
  attempted: number;
  delivered_count: number;
  graph_message_id: string | undefined;
  last_status: number | undefined;
}

export async function sendDailyReport(args: SendDailyReportArgs): Promise<SendDailyReportResult> {
  const subject = renderSubject(args.report, args.subjectTemplate);
  const htmlBody = renderHtmlBody(args.report, {
    includeBonusDollars: args.includeBonusDollars,
    includeComparisons: args.includeComparisons,
  });

  let delivered_count = 0;
  let graph_message_id: string | undefined;
  let last_status: number | undefined;

  for (const to of args.recipients) {
    try {
      const r = await sendSystemEmail({ to, subject, htmlBody, importance: 'normal' });
      if (r.disabled) {
        log.warn({ to }, '[daily-report] M365 disabled — skip');
        continue;
      }
      if (r.delivered) delivered_count += 1;
      else log.warn({ to, lastStatus: r.lastStatus }, '[daily-report] send failed');
      graph_message_id = r.messageId;
      last_status = r.lastStatus ?? last_status;
    } catch (e) {
      log.warn({ err: e, to }, '[daily-report] send threw');
    }
  }

  return {
    attempted: args.recipients.length,
    delivered_count,
    graph_message_id,
    last_status,
  };
}
