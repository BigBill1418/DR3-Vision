// ADR-0045 §3 addendum (planning rollup 2026-07-08 §1.8) — board-pack DIGEST SEND.
//
// Distinct from the DRAFT generator in `@/lib/ops/update-digest.ts`: that one
// composes copy-ready markdown for a human to edit + send by hand and NEVER
// touches a mail path. THIS module is Bethany's board-pack digest — Vision
// renders it and sends it through the ADR-0047 rollout chokepoint (`notifyStaff`).
//
// Cadence (same calendar as the draft, `@/lib/ops/digest-calendar`): the 2nd
// Wednesday of the month OR the Monday immediately preceding it — both map to
// ONE `period_start` (first-of-previous-month), so the double-trigger and any
// same-day re-fire collapse to a single send/month via the `board_pack_send_log`
// unique idempotency ledger.
//
// Rollout: `board_pack_digest` is an ORG-WIDE surface, born PILOT — so until Bill
// ramps BOTH sites live from /admin/rollout, `notifyStaff` reroutes to admins.
// This module never imports `@/lib/m365-mail` (ADR-0047 chokepoint; enforced by
// the repo no-direct-mail test).

import { prisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { notifyStaff, type NotifyStaffMode } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { isBoardPackDay, previousMonthEnd, previousMonthStart } from '@/lib/ops/digest-calendar';
import { appToday, dayISO, pacificMonthLabel } from '@/lib/time';
import { log } from '@/lib/observability/logger';

// Literal P&L section — GP (Great Plains) financial integration is not wired yet.
const PL_PLACEHOLDER = 'Financials: pending GP integration';

// SVdP brand tokens (mirrors src/lib/bonus/daily-report-notifications.ts — the
// outgoing report email uses the parent-org SVdP palette, distinct from the DR3
// green/black in-app brand). Self-hosted public logo so mail clients can load it.
const SVDP_RED = '#a3151a';
const SVDP_GOLD = '#ffcc69';
const SVDP_CREAM = '#f7f3ea';
const INK = '#2b2b2b';
const MUTED = '#6b6b6b';
const HAIRLINE = '#e6ddca';
const UP_GREEN = '#2e7d32';
const SVDP_LOGO_URL = 'https://dr3-vision.svdp.us/brand/svdp-logo-white.png';

export interface SiteRef {
  id: string;
  code: string;
  name: string;
}

const toNum = (v: unknown): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Integer or one-decimal (half-unit precision), with thousands separators. */
function fmtUnits(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// ── Schedule predicate ──────────────────────────────────────────────────

/**
 * True iff `dayKey` (a @db.Date-shaped Pacific day-key) is a board-pack SEND day:
 * the 2nd Wednesday of its month OR the preceding Monday. Delegates to the proven
 * calendar function so the send cadence and the draft cadence never diverge.
 */
export function isBoardPackSendDay(dayKey: Date): boolean {
  return isBoardPackDay(dayKey);
}

// ── Payload ─────────────────────────────────────────────────────────────

export interface SiteBoardPayload {
  code: string;
  name: string;
  /** Prev-month processed units (stripped_program + stripped_non_program). */
  prevMonthProduced: number;
  /** First-of-this-month through today. */
  mtdProduced: number;
  /** Same prev-month one year earlier; null when no prior-year history exists. */
  yoyPrevMonthProduced: number | null;
  /** prevMonthProduced − yoyPrevMonthProduced; null when no YoY baseline. */
  yoyDelta: number | null;
}

export interface BoardPackPayload {
  /** First-of-previous-month @db.Date — the send-idempotency anchor. */
  periodStart: Date;
  prevMonthLabel: string;
  mtdEndISO: string;
  sites: SiteBoardPayload[];
}

async function sumProducedRange(
  db: PrismaClient,
  siteId: string,
  start: Date,
  end: Date,
): Promise<{ sum: number; rows: number }> {
  const rows = await db.processedUnitsDaily.findMany({
    where: { site_id: siteId, production_date: { gte: start, lte: end } },
    select: { stripped_program: true, stripped_non_program: true },
  });
  const sum = rows.reduce((a, r) => a + toNum(r.stripped_program) + toNum(r.stripped_non_program), 0);
  return { sum, rows: rows.length };
}

/**
 * Compute the board-pack numbers for each site: prev-month processed units, MTD
 * current, and YoY (same prev-month one year earlier). All windows use the
 * @db.Date UTC-Y/M/D invariant (see src/lib/time.ts) so the math is DST-free.
 */
export async function buildBoardPackPayload(
  sites: SiteRef[],
  today: Date,
  db: PrismaClient = prisma,
): Promise<BoardPackPayload> {
  const prevStart = previousMonthStart(today);
  const prevEnd = previousMonthEnd(today);
  const mtdStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  // YoY = the same prev-month window shifted back one year (shiftYear invariant).
  const yoyStart = new Date(Date.UTC(prevStart.getUTCFullYear() - 1, prevStart.getUTCMonth(), 1));
  const yoyEnd = new Date(Date.UTC(prevStart.getUTCFullYear() - 1, prevStart.getUTCMonth() + 1, 0));

  const out: SiteBoardPayload[] = [];
  for (const s of sites) {
    const [prev, mtd, yoy] = await Promise.all([
      sumProducedRange(db, s.id, prevStart, prevEnd),
      sumProducedRange(db, s.id, mtdStart, today),
      sumProducedRange(db, s.id, yoyStart, yoyEnd),
    ]);
    const yoyVal = yoy.rows > 0 ? yoy.sum : null;
    out.push({
      code: s.code,
      name: s.name,
      prevMonthProduced: prev.sum,
      mtdProduced: mtd.sum,
      yoyPrevMonthProduced: yoyVal,
      yoyDelta: yoyVal === null ? null : prev.sum - yoyVal,
    });
  }

  return {
    periodStart: prevStart,
    prevMonthLabel: pacificMonthLabel(prevStart),
    mtdEndISO: dayISO(today),
    sites: out,
  };
}

// ── Render (SVdP-branded email shell) ───────────────────────────────────

function siteBlockHtml(s: SiteBoardPayload, periodLabel: string, mtdEndISO: string): string {
  const th = `text-align:left;padding:0 0 6px;font:600 11px/1 -apple-system,'Segoe UI',sans-serif;color:${SVDP_RED};text-transform:uppercase;letter-spacing:0.06em`;
  const rowCell = `padding:7px 0;border-top:1px solid ${HAIRLINE};font-size:14px;color:${INK}`;
  const firstCell = `padding:7px 0;font-size:14px;color:${INK}`;
  const numTd = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:16px';

  let yoyLine: string;
  if (s.yoyPrevMonthProduced === null) {
    yoyLine = `<td style="${rowCell};${numTd};color:${MUTED}"><em>no prior-year history</em></td>`;
  } else {
    const delta = s.yoyDelta ?? 0;
    const up = delta >= 0;
    const sign = up ? '+' : '';
    const arrow = up ? '▲' : '▼';
    const color = up ? UP_GREEN : SVDP_RED;
    yoyLine = `<td style="${rowCell};${numTd}"><strong>${fmtUnits(s.yoyPrevMonthProduced)}</strong> <span style="color:${color}">(${sign}${fmtUnits(delta)} ${arrow})</span></td>`;
  }

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;background:${SVDP_CREAM};border-left:3px solid ${SVDP_GOLD};border-radius:4px">
    <tr><td style="padding:14px 16px">
      <div style="font:700 15px/1.2 -apple-system,'Segoe UI',sans-serif;color:${INK};padding-bottom:10px">${escapeHtml(s.name)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr><th style="${th}" colspan="2">&nbsp;</th></tr>
        <tr><td style="${firstCell}">${escapeHtml(periodLabel)} processed units</td><td style="${firstCell};${numTd}"><strong>${fmtUnits(s.prevMonthProduced)}</strong></td></tr>
        <tr><td style="${rowCell}">Month-to-date (through ${escapeHtml(mtdEndISO)})</td><td style="${rowCell};${numTd}"><strong>${fmtUnits(s.mtdProduced)}</strong></td></tr>
        <tr><td style="${rowCell}">Year-over-year (${escapeHtml(periodLabel)} vs prior year)</td>${yoyLine}</tr>
      </table>
    </td></tr>
  </table>`;
}

/**
 * Render the board-pack digest as an SVdP-branded HTML email. Every interpolated
 * value is HTML-escaped; the numbers are the only dynamic content besides the
 * period label. Includes the literal P&L placeholder; NO safety/injuries section.
 */
export function renderBoardPackHtml(payload: BoardPackPayload, periodLabel: string): string {
  const siteBlocks = payload.sites
    .map((s) => siteBlockHtml(s, periodLabel, payload.mtdEndISO))
    .join('');

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
              <div style="color:#ffffff;font-size:17px;font-weight:700;line-height:1.25">DR3 Board Pack</div>
              <div style="color:#f3d7d8;font-size:13px;padding-top:2px">${escapeHtml(periodLabel)} (processed) · month-to-date through ${escapeHtml(payload.mtdEndISO)}</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="height:4px;background:${SVDP_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 24px 26px">
          ${siteBlocks}
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;border:1px dashed ${HAIRLINE};border-radius:4px">
            <tr><td style="padding:12px 16px">
              <div style="font:600 11px/1 -apple-system,'Segoe UI',sans-serif;color:${SVDP_RED};text-transform:uppercase;letter-spacing:0.06em;padding-bottom:6px">Profit &amp; loss</div>
              <div style="font-size:13px;color:${MUTED};font-style:italic">${escapeHtml(PL_PLACEHOLDER)}</div>
            </td></tr>
          </table>
          <p style="color:${MUTED};font-size:11px;line-height:1.5;margin:22px 0 0;border-top:1px solid ${HAIRLINE};padding-top:14px">
            Sent automatically by DR3-Vision — board-pack digest.<br>
            St. Vincent de Paul Society of Lane County
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Send entrypoint ─────────────────────────────────────────────────────

export interface SendBoardPackArgs {
  /** Test seam — the instant used to derive today (defaults to now). */
  now?: Date;
  db?: PrismaClient;
  /** Sites to report on; loaded from the DB when omitted. */
  sites?: SiteRef[];
}

export type BoardPackSkipReason = 'not_board_pack_day' | 'already_sent' | 'mail_disabled';

export interface BoardPackSendResult {
  skipped: boolean;
  reason?: BoardPackSkipReason;
  mode?: NotifyStaffMode;
  /** First-of-previous-month ISO (the send anchor), when a send was attempted. */
  periodStart?: string;
  recipientsCount?: number;
  delivered?: number;
}

/**
 * The board-pack digest send. Idempotent per `period_start`: the 2nd-Wednesday +
 * preceding-Monday double-trigger and any same-day re-fire all collapse to one
 * send/month. On a non-board-pack day it is a clean no-op. When M365 is
 * unconfigured (`notified.disabled`) it does NOT record the send-log row, so the
 * send re-attempts once mail is configured.
 */
export async function sendBoardPackDigest(
  args: SendBoardPackArgs = {},
): Promise<BoardPackSendResult> {
  const db = args.db ?? prisma;
  const today = appToday(args.now);

  if (!isBoardPackSendDay(today)) {
    return { skipped: true, reason: 'not_board_pack_day' };
  }

  const periodStart = previousMonthStart(today);
  const periodISO = dayISO(periodStart);

  const already = await db.boardPackSendLog.findUnique({
    where: { period_start: periodStart },
    select: { id: true },
  });
  if (already) {
    log.info({ periodStart: periodISO }, '[board-pack] already sent this period — no-op');
    return { skipped: true, reason: 'already_sent', periodStart: periodISO };
  }

  const recipientRows = await db.boardPackRecipient.findMany({
    where: { active: true },
    select: { email: true },
    orderBy: { email: 'asc' },
  });
  const recipients = recipientRows.map((r) => r.email);

  const sites = args.sites ?? (await db.site.findMany({ select: { id: true, code: true, name: true } }));
  const payload = await buildBoardPackPayload(sites, today, db);
  const htmlBody = renderBoardPackHtml(payload, payload.prevMonthLabel);
  const subject = `DR3-Vision Board Pack — ${payload.prevMonthLabel}`;

  const notified = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.BOARD_PACK_DIGEST,
    site: null,
    recipients,
    subject,
    htmlBody,
    fromDisplayName: 'DR3-Vision Board Pack',
    db,
  });

  // M365 unconfigured — fail-open no-op. Do NOT persist the send-log, so the
  // send re-attempts on the next board-pack tick once mail is configured.
  if (notified.disabled) {
    log.warn({ periodStart: periodISO }, '[board-pack] M365 disabled — send skipped, no ledger row');
    return { skipped: true, reason: 'mail_disabled', mode: notified.mode, periodStart: periodISO };
  }

  // Record the send exactly once so a re-fire is an `already_sent` no-op.
  await db.boardPackSendLog.create({
    data: {
      period_start: periodStart,
      recipients_count: notified.intendedRecipients.length,
      mode: notified.mode,
    },
  });

  log.info(
    {
      periodStart: periodISO,
      mode: notified.mode,
      recipients: notified.intendedRecipients.length,
      delivered: notified.delivered,
    },
    '[board-pack] digest sent',
  );

  return {
    skipped: false,
    mode: notified.mode,
    periodStart: periodISO,
    recipientsCount: notified.intendedRecipients.length,
    delivered: notified.delivered,
  };
}
