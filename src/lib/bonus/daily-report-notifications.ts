// ADR-0030 — Render + send the daily production email.
//
// Subject from the config's subject_template ({site} and {date} substituted).
// HTML body uses the new "DR3 - {Site} Automated Production Report" header.
// Per-recipient send so one bad address never blocks the others. Never throws.

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import { formatCents } from '@/lib/bonus/calculator';
import type { DailyReport, ComparisonTotal } from '@/lib/bonus/daily-report';
import type { EodInventorySnapshot } from '@/lib/loads/eod-inventory';

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
/**
 * A physical-count `snapshot_at` is a true INSTANT, not a @db.Date day — render
 * it in Bill's Pacific wall clock (CLAUDE.md time rule). Formatting it in UTC
 * would push an afternoon count onto the following day.
 */
const PACIFIC_SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'America/Los_Angeles',
});
function fmtInstantShortPT(d: Date): string {
  return PACIFIC_SHORT_DATE.format(d);
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

/** Whole-unit display for a units figure (Decimal(7,1) flows can be fractional). */
function fmtUnits(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('en-US');
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
// White SVdP wordmark — served from our own public asset (dr3-vision.svdp.us),
// not hotlinked off the WordPress site (that URL 404'd / is not reliable in mail
// clients). The PNG is checked in at public/brand/svdp-logo-white.png.
const SVDP_LOGO_URL = 'https://dr3-vision.svdp.us/brand/svdp-logo-white.png';

// ─────────────────────────────────────────────────────────────────────
// ADR-0037 Phase 4 (spec §4) — End-of-Day Inventory section
//
// HARD RULE: the healthy block (on-hand figures, delta, split) renders ONLY for
// `state === 'healthy'` — a fresh `measured` physical anchor. `stale` and `zero`
// each get their own band and NO figures. Presenting a drifted computed balance
// as a floor count is exactly the mis-billing hazard the gate exists to prevent.
// ─────────────────────────────────────────────────────────────────────

const WARN_BG = '#FEF3C7';
const WARN_BORDER = '#F59E0B';
const WARN_INK = '#92400E';

function eodRowHtml(label: string, value: string, strong = false): string {
  const cell = `padding:3px 0;font-size:13px;color:${INK}`;
  const v = strong ? `<strong>${value}</strong>` : value;
  return `<tr><td style="${cell}">${escapeHtml(label)}</td><td style="${cell};text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:16px">${v}</td></tr>`;
}

function eodDeltaHtml(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return 'no change';
  const up = rounded > 0;
  const sign = up ? '+' : '−';
  const color = up ? UP_GREEN : SVDP_RED;
  const note = up ? 'net inbound' : 'net outbound';
  return `<strong style="color:${color}">${sign}${fmtUnits(Math.abs(rounded))}</strong> <span style="color:${MUTED}">(${note})</span>`;
}

function eodPanel(siteName: string, inner: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;background:${SVDP_CREAM};border-left:3px solid ${SVDP_GOLD};border-radius:4px">
    <tr><td style="padding:14px 16px">
      <div style="font:600 11px/1 -apple-system,'Segoe UI',sans-serif;color:${SVDP_RED};text-transform:uppercase;letter-spacing:0.06em;padding-bottom:6px">End-of-Day Inventory — ${escapeHtml(siteName)}</div>
      ${inner}
    </td></tr>
  </table>`;
}

export function renderEodInventoryHtml(
  eod: EodInventorySnapshot | undefined,
  siteName: string,
): string {
  if (!eod) return '';

  if (eod.state === 'zero') {
    return eodPanel(
      siteName,
      `<div style="font-size:13px;color:${MUTED};line-height:1.5">No inventory activity recorded yet — awaiting the first physical count and daily entries.</div>`,
    );
  }

  if (eod.state === 'stale') {
    const anchorLine = eod.anchor
      ? `Last measured anchor: <strong>${escapeHtml(fmtInstantShortPT(eod.anchor.countedAt))}</strong> (${eod.anchor.daysSince} ${eod.anchor.daysSince === 1 ? 'day' : 'days'} ago)`
      : 'No physical count on record for this site.';
    return eodPanel(
      siteName,
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:10px 12px;background:${WARN_BG};border:1px solid ${WARN_BORDER};border-radius:6px;font:13px/1.5 -apple-system,'Segoe UI',sans-serif;color:${WARN_INK}">` +
        `<strong>⚠ Inventory pending physical count</strong><br>${anchorLine}<br>` +
        `Computed balance is drift-prone; verify with a floor count.` +
        `</td></tr></table>`,
    );
  }

  // healthy — a `measured` anchor inside the freshness window.
  const split =
    eod.programPct === null || eod.nonProgramPct === null
      ? '<em>n/a</em>'
      : `${eod.programPct.toFixed(1)}% / ${eod.nonProgramPct.toFixed(1)}%`;
  const counted = eod.anchor
    ? `${fmtInstantShortPT(eod.anchor.countedAt)}${eod.anchor.daysSince === 0 ? ' (today)' : ` (${eod.anchor.daysSince} ${eod.anchor.daysSince === 1 ? 'day' : 'days'} ago)`}`
    : '—';
  const rows =
    eodRowHtml('Program units on hand', fmtUnits(eod.programOnHand), true) +
    eodRowHtml('Non-program units on hand', fmtUnits(eod.nonProgramOnHand), true) +
    eodRowHtml('Total on hand', fmtUnits(eod.totalOnHand), true) +
    `<tr><td colspan="2" style="height:6px;font-size:0;line-height:0">&nbsp;</td></tr>` +
    `<tr><td style="padding:3px 0;font-size:13px;color:${INK}">Change from yesterday</td><td style="padding:3px 0;font-size:13px;color:${INK};text-align:right;white-space:nowrap;padding-left:16px">${eodDeltaHtml(eod.deltaFromYesterday)}</td></tr>` +
    eodRowHtml('Program / non-program split', split) +
    eodRowHtml('Latest physical count', counted) +
    // Counter is a stored user/system name — escaped, it is the one untrusted
    // string in this panel.
    eodRowHtml('Counter', escapeHtml(eod.anchor?.counter ?? '—'));
  return eodPanel(
    siteName,
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>`,
  );
}

export interface RenderOptions {
  includeBonusDollars: boolean;
  includeComparisons: boolean;
  lateInfo?: LateSubmissionInfo | undefined;
}

export function renderHtmlBody(report: DailyReport, opts: RenderOptions): string {
  // Masthead title. "DR3" is intentionally NOT repeated here — it already
  // leads the subject line ("DR3 Daily Production Report — …") and the footer
  // ("DR3-Vision"); the SVdP logo carries the parent-org brand on the masthead.
  const headerLine = `${report.siteName} Daily Production Report`;

  // Late-submission banner (2026-07-11 Bill directive): when the data arrived
  // after the scheduled send, the team still gets the report immediately — the
  // banner says exactly when it was submitted, and whether this supersedes an
  // earlier send for the same day.
  const lateBanner = opts.lateInfo
    ? `<tr><td style="padding:10px 14px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:6px;font:600 13px/1.4 -apple-system,'Segoe UI',sans-serif;color:#92400E">` +
      `Late submission — production data entered at ${escapeHtml(opts.lateInfo.enteredAtPT)} ` +
      `(scheduled report time ${escapeHtml(opts.lateInfo.scheduledPT)}).` +
      (opts.lateInfo.isResend ? ' This report supersedes the earlier send for this day.' : '') +
      `</td></tr><tr><td style="height:10px"></td></tr>`
    : '';

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
        ${cmp(`Same day last year — ${report.sameDayLastYear.startDate.getUTCFullYear()} (${fmtShort(report.sameDayLastYear.startDate)})`, report.sameDayLastYear)}
        ${cmp(`Month-to-date (${fmtRange(report.mtd.startDate, report.mtd.endDate)})`, report.mtd)}
        ${cmp(`Same period last month — ${report.priorMonthSamePeriod.startDate.getUTCFullYear()} (${fmtRange(report.priorMonthSamePeriod.startDate, report.priorMonthSamePeriod.endDate)})`, report.priorMonthSamePeriod)}
        <tr><td style="padding:3px 0;font-size:13px;color:${INK}">${paceLine}</td></tr>
      </table>
    </td></tr>
  </table>`;
  }

  // ADR-0037 Phase 4 — EOD inventory section (healthy / stale / zero, or omitted
  // when the inventory read failed). Always after the trend block.
  const eodBlock = renderEodInventoryHtml(report.eodInventory, report.siteName);

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
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${lateBanner}</table>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
            <thead>${headerRow}</thead>
            <tbody>${rows}</tbody>
            <tfoot>${footerRow}</tfoot>
          </table>${comparisonBlock}${eodBlock}
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

/**
 * 2026-07-11 (Bill directive) — a report (re)sent by the on-save late path
 * carries WHEN the data was submitted, front and center. `enteredAtPT` /
 * `scheduledPT` are pre-formatted Pacific wall-clock strings; `isResend` marks
 * a send that supersedes an earlier report for the same day.
 */
export interface LateSubmissionInfo {
  enteredAtPT: string;
  scheduledPT: string;
  isResend: boolean;
}

export interface SendDailyReportArgs {
  report: DailyReport;
  recipients: readonly string[];
  subjectTemplate: string;
  includeBonusDollars: boolean;
  includeComparisons: boolean;
  lateInfo?: LateSubmissionInfo;
}

export interface SendDailyReportResult {
  attempted: number;
  delivered_count: number;
  graph_message_id: string | undefined;
  last_status: number | undefined;
}

export async function sendDailyReport(args: SendDailyReportArgs): Promise<SendDailyReportResult> {
  const subject =
    renderSubject(args.report, args.subjectTemplate) +
    (args.lateInfo ? (args.lateInfo.isResend ? ' — UPDATED (late entry)' : ' — LATE ENTRY') : '');
  const htmlBody = renderHtmlBody(args.report, {
    includeBonusDollars: args.includeBonusDollars,
    includeComparisons: args.includeComparisons,
    lateInfo: args.lateInfo,
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
