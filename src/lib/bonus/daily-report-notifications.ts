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
//
// Branded to St. Vincent de Paul Society of Lane County (svdp.us) per
// operator request 2026-06-17: SVdP red masthead + white SVdP logo + cream
// panels. (This intentionally uses the SVdP parent-org palette, distinct from
// the DR3 green/black in-app brand — Bill asked for svdp.us branding on the
// outgoing report email specifically.) Table-based, inline-styled, ≤600px so
// it renders consistently across Outlook / M365 / mobile mail clients.
// ─────────────────────────────────────────────────────────────────────

// SVdP brand tokens (sampled from www.svdp.us).
const SVDP_RED = '#a3151a';
const SVDP_GOLD = '#ffcc69';
const SVDP_CREAM = '#f7f3ea';
const INK = '#2b2b2b';
const MUTED = '#6b6b6b';
const HAIRLINE = '#e6ddca';
const UP_GREEN = '#2e7d32';
// White SVdP wordmark — content-negotiates to PNG for clients that don't take webp.
const SVDP_LOGO_URL = 'https://www.svdp.us/wp-content/uploads/2021/09/svdp-logo-white-300x300.png';

export interface RenderOptions {
  includeBonusDollars: boolean;
  includeComparisons: boolean;
}

export function renderHtmlBody(report: DailyReport, opts: RenderOptions): string {
  // Kept verbatim so downstream consumers/tests can key on it.
  const headerLine = `DR3 - ${report.siteName} Automated Production Report`;

  const showBonus = opts.includeBonusDollars;
  const numTd = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap';
  const th = `text-align:right;padding:0 0 6px;font:600 11px/1 -apple-system,'Segoe UI',sans-serif;color:${SVDP_RED};text-transform:uppercase;letter-spacing:0.06em`;

  const rows = report.lines
    .map((l, i) => {
      const name = escapeHtml(l.fullName);
      const rowBorder = i === 0 ? '' : `border-top:1px solid ${HAIRLINE};`;
      const cell = `padding:7px 0;${rowBorder}font-size:14px;color:${INK}`;
      const bonusCell = showBonus
        ? `<td style="${cell};${numTd};padding-left:16px;color:${MUTED}">${formatCents(l.bonusCents)}</td>`
        : '';
      return `<tr><td style="${cell}">${name}</td><td style="${cell};${numTd};padding-left:16px"><strong>${l.mattresses.toLocaleString('en-US')}</strong></td>${bonusCell}</tr>`;
    })
    .join('');

  const headerRow = `<tr><th style="text-align:left;padding:0 0 6px;font:600 11px/1 -apple-system,'Segoe UI',sans-serif;color:${SVDP_RED};text-transform:uppercase;letter-spacing:0.06em">Processor</th><th style="${th};padding-left:16px">Units</th>${showBonus ? `<th style="${th};padding-left:16px">Bonus</th>` : ''}</tr>`;

  const totalCell = `padding:10px 0 0;border-top:2px solid ${SVDP_RED};font-size:14px;font-weight:700;color:${INK}`;
  const footerRow = `<tr><td style="${totalCell}">Total processed today</td><td style="${totalCell};${numTd};padding-left:16px">${report.totalToday.toLocaleString('en-US')}</td>${showBonus ? `<td style="${totalCell};${numTd};padding-left:16px">${formatCents(report.totalBonusCents)}</td>` : ''}</tr>`;

  let comparisonBlock = '';
  if (opts.includeComparisons) {
    const paceLine = (() => {
      if (report.paceDeltaPct === null) {
        return `<span style="color:${MUTED}">Pace vs. last month: <em>no comparable history yet</em></span>`;
      }
      const up = report.paceDeltaPct >= 0;
      const sign = up ? '+' : '';
      const arrow = up ? '▲' : '▼';
      const color = up ? UP_GREEN : SVDP_RED;
      return `Pace vs. last month: <strong style="color:${color}">${sign}${report.paceDeltaPct.toFixed(1)}% ${arrow}</strong>`;
    })();
    const cmp = (label: string, c: ComparisonTotal) =>
      `<tr><td style="padding:3px 0;font-size:13px;color:${INK}">${comparisonLineHtml(label, c)}</td></tr>`;
    comparisonBlock = `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;background:${SVDP_CREAM};border-left:3px solid ${SVDP_GOLD};border-radius:4px">
    <tr><td style="padding:14px 16px">
      <div style="font:600 11px/1 -apple-system,'Segoe UI',sans-serif;color:${SVDP_RED};text-transform:uppercase;letter-spacing:0.06em;padding-bottom:6px">Trend</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        ${cmp(`Same day last year (${fmtShort(report.sameDayLastYear.startDate)})`, report.sameDayLastYear)}
        ${cmp(`Month-to-date (${fmtRange(report.mtd.startDate, report.mtd.endDate)})`, report.mtd)}
        ${cmp(`Same period last month (${fmtRange(report.priorMonthSamePeriod.startDate, report.priorMonthSamePeriod.endDate)})`, report.priorMonthSamePeriod)}
        <tr><td style="padding:3px 0;font-size:13px;color:${INK}">${paceLine}</td></tr>
      </table>
    </td></tr>
  </table>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${SVDP_CREAM}">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${SVDP_CREAM}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${SVDP_RED};padding:18px 24px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="vertical-align:middle"><img src="${SVDP_LOGO_URL}" width="44" height="44" alt="St. Vincent de Paul Society of Lane County" style="display:block;border:0;width:44px;height:44px"></td>
            <td style="vertical-align:middle;padding-left:14px">
              <div style="color:#ffffff;font-size:17px;font-weight:700;line-height:1.25">${escapeHtml(headerLine)}</div>
              <div style="color:#f3d7d8;font-size:13px;padding-top:2px">${escapeHtml(fmtFull(report.reportDate))}</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="height:4px;background:${SVDP_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 24px 26px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
            <thead>${headerRow}</thead>
            <tbody>${rows}</tbody>
            <tfoot>${footerRow}</tfoot>
          </table>${comparisonBlock}
          <p style="color:${MUTED};font-size:11px;line-height:1.5;margin:22px 0 0;border-top:1px solid ${HAIRLINE};padding-top:14px">
            Sent automatically by DR3-Vision — replaces the manual daily processing email.<br>
            St. Vincent de Paul Society of Lane County
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
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
