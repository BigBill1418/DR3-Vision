// ADR-0045 D2 — DR3 Updates digest + board pack: Vision DRAFTS, a human SENDS.
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ LOCKED DISPOSITION — this module has NO mail path. It generates a DRAFT, │
// │ lets a human edit + finalize the markdown, and renders copy-ready HTML   │
// │ with a copy-to-clipboard affordance. Vision NEVER sends this digest and  │
// │ never impersonates Morena/Bethany. A companion test scans this file's    │
// │ source and fails if it contains any outbound-mail import or send call —  │
// │ so do NOT add one here. The D3 intake notification is the only email     │
// │ Vision itself sends; this digest is always human-sent.                   │
// └────────────────────────────────────────────────────────────────────────┘
//
// The weekly Updates digest rides the daily-report tick (Monday generation,
// covering the prior week). The board pack rides the same tick on Bethany's
// cadence (2nd Wednesday + preceding Monday). Both are idempotent per
// (kind, period_start): a re-fire is a no-op so human edits are never clobbered.

import type { UpdateDigest } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { appToday, dayISO, pacificDateLabel, pacificMonthLabel } from '@/lib/time';
import { log } from '@/lib/observability/logger';
import {
  isBoardPackDay,
  isWeeklyGenerationDay,
  previousMonthEnd,
  previousMonthStart,
  previousWeekRange,
} from './digest-calendar';
import { absentEquipmentProvider, type EquipmentProvider } from './equipment-provider';

const GENERATED_BY = 'system:update-digest';
// Board-pack "big known cost bump" threshold (ADR-0044 equipment `cost` events).
const BIG_COST_CENTS = 500_000; // $5,000

const toNum = (v: unknown): number =>
  v == null ? 0 : typeof v === 'number' ? v : Number(v);

export interface UpdateDigestDeps {
  equipment?: EquipmentProvider;
}

// ── Data gathering ────────────────────────────────────────────────────────

interface SiteRef {
  id: string;
  code: string;
  name: string;
}

async function sumProduced(siteId: string, startISO: string, endISO: string): Promise<number> {
  const rows = await prisma.processedUnitsDaily.findMany({
    where: { site_id: siteId, production_date: { gte: dateKey(startISO), lte: dateKey(endISO) } },
    select: { stripped_program: true, stripped_non_program: true },
  });
  return rows.reduce((a, r) => a + toNum(r.stripped_program) + toNum(r.stripped_non_program), 0);
}

async function sumInboundUnits(siteId: string, startISO: string, endISO: string): Promise<number> {
  const rows = await prisma.consumerDropoff.findMany({
    where: { site_id: siteId, dropoff_date: { gte: dateKey(startISO), lte: dateKey(endISO) } },
    select: { units: true },
  });
  return rows.reduce((a, r) => a + r.units, 0);
}

async function sumOutbound(
  siteId: string,
  startISO: string,
  endISO: string,
): Promise<{ wholeUnits: number; weightLbs: number }> {
  const rows = await prisma.outboundMaterial.findMany({
    where: { site_id: siteId, ship_date: { gte: dateKey(startISO), lte: dateKey(endISO) } },
    select: { whole_units: true, weight_lbs: true },
  });
  return {
    wholeUnits: rows.reduce((a, r) => a + (r.whole_units ?? 0), 0),
    weightLbs: rows.reduce((a, r) => a + r.weight_lbs, 0),
  };
}

async function openFindingCount(siteId: string): Promise<number> {
  return prisma.auditFinding.count({ where: { site_id: siteId, status: 'open' } });
}

async function completedTaskTitles(
  siteId: string,
  startISO: string,
  endISO: string,
): Promise<string[]> {
  const rows = await prisma.opsTask.findMany({
    where: {
      OR: [{ site_id: siteId }, { site_id: null }],
      status: 'done',
      completed_at: { gte: instant(startISO), lt: instantPlusDay(endISO) },
    },
    orderBy: { completed_at: 'desc' },
    select: { title: true },
  });
  return rows.map((r) => r.title);
}

function dateKey(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function instant(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function instantPlusDay(iso: string): Date {
  return new Date(dateKey(iso).getTime() + 86_400_000);
}

// ── Weekly digest ───────────────────────────────────────────────────────

interface SiteWeeklyStats {
  code: string;
  name: string;
  produced: number;
  inboundUnits: number;
  outboundWholeUnits: number;
  outboundWeightLbs: number;
  openFindings: number;
  completedTasks: string[];
}

async function gatherWeeklyStats(
  sites: SiteRef[],
  startISO: string,
  endISO: string,
): Promise<SiteWeeklyStats[]> {
  const out: SiteWeeklyStats[] = [];
  for (const s of sites) {
    const [produced, inboundUnits, outbound, openFindings, completedTasks] = await Promise.all([
      sumProduced(s.id, startISO, endISO),
      sumInboundUnits(s.id, startISO, endISO),
      sumOutbound(s.id, startISO, endISO),
      openFindingCount(s.id),
      completedTaskTitles(s.id, startISO, endISO),
    ]);
    out.push({
      code: s.code,
      name: s.name,
      produced,
      inboundUnits,
      outboundWholeUnits: outbound.wholeUnits,
      outboundWeightLbs: outbound.weightLbs,
      openFindings,
      completedTasks,
    });
  }
  return out;
}

/** Pure — build the weekly Updates markdown from gathered stats. */
export function composeWeeklyMarkdown(
  startISO: string,
  endISO: string,
  sites: SiteWeeklyStats[],
  equipmentAvailable: boolean,
): string {
  const lines: string[] = [];
  lines.push(`# DR3 Updates — week of ${startISO} to ${endISO}`);
  lines.push('');
  lines.push('_Draft generated by DR3-Vision. Review, edit, then send from your own mail._');
  lines.push('');
  for (const s of sites) {
    lines.push(`## ${s.name}`);
    lines.push('');
    lines.push(`- Processed units: ${fmt(s.produced)}`);
    lines.push(`- Inbound (drop-off units): ${fmt(s.inboundUnits)}`);
    lines.push(
      `- Outbound: ${fmt(s.outboundWholeUnits)} whole units, ${fmt(s.outboundWeightLbs)} lbs`,
    );
    lines.push(`- Open audit findings: ${fmt(s.openFindings)}`);
    if (s.completedTasks.length > 0) {
      lines.push(`- Completed follow-ups (${s.completedTasks.length}):`);
      for (const t of s.completedTasks) lines.push(`  - ${t}`);
    } else {
      lines.push('- Completed follow-ups: none');
    }
    lines.push('');
  }
  if (!equipmentAvailable) {
    lines.push('> Equipment events unavailable in this build (ADR-0044 module pending merge).');
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── Board pack ─────────────────────────────────────────────────────────

interface SiteBoardStats {
  code: string;
  name: string;
  prevMonthProduced: number;
  mtdProduced: number;
  yoyPrevMonthProduced: number | null;
  bigCostEvents: string[];
}

async function gatherBoardStats(
  sites: SiteRef[],
  prevMonthStartISO: string,
  prevMonthEndISO: string,
  mtdStartISO: string,
  mtdEndISO: string,
  equipment: EquipmentProvider,
): Promise<SiteBoardStats[]> {
  const yoyStartISO = shiftYear(prevMonthStartISO, -1);
  const yoyEndISO = shiftYear(prevMonthEndISO, -1);
  const out: SiteBoardStats[] = [];
  for (const s of sites) {
    const [prevMonthProduced, mtdProduced, yoyProduced, costEvents] = await Promise.all([
      sumProduced(s.id, prevMonthStartISO, prevMonthEndISO),
      sumProduced(s.id, mtdStartISO, mtdEndISO),
      sumProduced(s.id, yoyStartISO, yoyEndISO),
      equipment.bigCostEvents(s.id, prevMonthStartISO, prevMonthEndISO, BIG_COST_CENTS),
    ]);
    const hasHistory = await hasProductionHistory(s.id, yoyStartISO, yoyEndISO);
    out.push({
      code: s.code,
      name: s.name,
      prevMonthProduced,
      mtdProduced,
      yoyPrevMonthProduced: hasHistory ? yoyProduced : null,
      bigCostEvents: costEvents.map(
        (e) => `${e.label} (${e.costCents == null ? 'n/a' : dollars(e.costCents)})`,
      ),
    });
  }
  return out;
}

async function hasProductionHistory(
  siteId: string,
  startISO: string,
  endISO: string,
): Promise<boolean> {
  const n = await prisma.processedUnitsDaily.count({
    where: { site_id: siteId, production_date: { gte: dateKey(startISO), lte: dateKey(endISO) } },
  });
  return n > 0;
}

function shiftYear(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-');
  return `${Number(y) + delta}-${m}-${d}`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pure — build the board-pack markdown from gathered stats. */
export function composeBoardPackMarkdown(
  prevMonthLabel: string,
  mtdEndISO: string,
  sites: SiteBoardStats[],
  equipmentAvailable: boolean,
): string {
  const lines: string[] = [];
  lines.push(`# DR3 Board Pack — ${prevMonthLabel} (processed) + month-to-date`);
  lines.push('');
  lines.push('_Draft generated by DR3-Vision. Review, edit, then send from your own mail._');
  lines.push('');
  for (const s of sites) {
    lines.push(`## ${s.name}`);
    lines.push('');
    lines.push(`- ${prevMonthLabel} processed units: ${fmt(s.prevMonthProduced)}`);
    lines.push(`- Month-to-date (through ${mtdEndISO}): ${fmt(s.mtdProduced)}`);
    if (s.yoyPrevMonthProduced !== null) {
      const delta = s.prevMonthProduced - s.yoyPrevMonthProduced;
      const sign = delta >= 0 ? '+' : '';
      lines.push(
        `- Year-over-year (${prevMonthLabel} vs prior year): ${fmt(s.yoyPrevMonthProduced)} → ${fmt(s.prevMonthProduced)} (${sign}${fmt(delta)})`,
      );
    } else {
      lines.push('- Year-over-year: no prior-year history');
    }
    if (s.bigCostEvents.length > 0) {
      lines.push(`- Big cost events (≥ ${dollars(BIG_COST_CENTS)}):`);
      for (const e of s.bigCostEvents) lines.push(`  - ${e}`);
    }
    lines.push('');
  }
  if (!equipmentAvailable) {
    lines.push(
      '> Equipment cost events unavailable in this build (ADR-0044 module pending merge).',
    );
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

// ── Idempotent draft upsert ────────────────────────────────────────────

async function upsertDraft(
  kind: 'weekly' | 'board_pack',
  periodStart: Date,
  periodEnd: Date,
  bodyMd: string,
): Promise<'created' | 'exists'> {
  const existing = await prisma.updateDigest.findUnique({
    where: { kind_period_start: { kind, period_start: periodStart } },
    select: { id: true },
  });
  if (existing) return 'exists';
  const digest = await prisma.updateDigest.create({
    data: {
      kind,
      period_start: periodStart,
      period_end: periodEnd,
      body_md: bodyMd,
      status: 'draft',
      generated_by: GENERATED_BY,
    },
  });
  await writeAudit({
    actor_label: GENERATED_BY,
    action: 'insert',
    table_name: 'update_digests',
    row_id: digest.id,
    after: { kind, period_start: dayISO(periodStart), period_end: dayISO(periodEnd) },
  });
  return 'created';
}

// ── Fire (rides the daily-report tick) ─────────────────────────────────

export type DigestFireStatus = 'created' | 'exists' | 'skipped_not_due';

export interface UpdateDigestFireOutcome {
  weekly: DigestFireStatus;
  boardPack: DigestFireStatus;
}

export async function runUpdateDigestFire(
  now: Date = new Date(),
  deps: UpdateDigestDeps = {},
): Promise<UpdateDigestFireOutcome> {
  const equipment = deps.equipment ?? absentEquipmentProvider;
  const today = appToday(now);
  const sites = await prisma.site.findMany({ select: { id: true, code: true, name: true } });

  let weekly: DigestFireStatus = 'skipped_not_due';
  let boardPack: DigestFireStatus = 'skipped_not_due';

  if (isWeeklyGenerationDay(today)) {
    try {
      weekly = await generateWeeklyDraft(sites, today, equipment);
    } catch (err) {
      log.error({ err }, '[update-digest] weekly generation failed (non-fatal)');
    }
  }
  if (isBoardPackDay(today)) {
    try {
      boardPack = await generateBoardPackDraft(sites, today, equipment);
    } catch (err) {
      log.error({ err }, '[update-digest] board-pack generation failed (non-fatal)');
    }
  }
  log.info({ weekly, boardPack }, '[update-digest] fire complete');
  return { weekly, boardPack };
}

export async function generateWeeklyDraft(
  sites: SiteRef[],
  today: Date,
  equipment: EquipmentProvider,
): Promise<DigestFireStatus> {
  const { start, end } = previousWeekRange(today);
  const startISO = dayISO(start);
  const endISO = dayISO(end);
  // Fast idempotency check before doing any gathering work.
  const existing = await prisma.updateDigest.findUnique({
    where: { kind_period_start: { kind: 'weekly', period_start: start } },
    select: { id: true },
  });
  if (existing) return 'exists';
  const stats = await gatherWeeklyStats(sites, startISO, endISO);
  const md = composeWeeklyMarkdown(startISO, endISO, stats, equipment.available);
  return upsertDraft('weekly', start, end, md);
}

export async function generateBoardPackDraft(
  sites: SiteRef[],
  today: Date,
  equipment: EquipmentProvider,
): Promise<DigestFireStatus> {
  const prevStart = previousMonthStart(today);
  const prevEnd = previousMonthEnd(today);
  const prevStartISO = dayISO(prevStart);
  const prevEndISO = dayISO(prevEnd);
  const mtdStartISO = dayISO(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
  const mtdEndISO = dayISO(today);
  const existing = await prisma.updateDigest.findUnique({
    where: { kind_period_start: { kind: 'board_pack', period_start: prevStart } },
    select: { id: true },
  });
  if (existing) return 'exists';
  const stats = await gatherBoardStats(
    sites,
    prevStartISO,
    prevEndISO,
    mtdStartISO,
    mtdEndISO,
    equipment,
  );
  const md = composeBoardPackMarkdown(pacificMonthLabel(prevStart), mtdEndISO, stats, equipment.available);
  // period_end spans through today (MTD) — store today as the end.
  return upsertDraft('board_pack', prevStart, today, md);
}

// ── Review-surface mutations ───────────────────────────────────────────

export class UpdateDigestError extends Error {
  constructor(
    public reason: string,
    public status: 404 | 409,
  ) {
    super(reason);
    this.name = 'UpdateDigestError';
  }
}

/** Edit a DRAFT's markdown. Finalized digests are immutable (409). Audited. */
export async function saveDigestBody(
  id: string,
  bodyMd: string,
  actorUserId: string,
): Promise<UpdateDigest> {
  const before = await prisma.updateDigest.findUnique({ where: { id } });
  if (!before) throw new UpdateDigestError('not_found', 404);
  if (before.status !== 'draft') throw new UpdateDigestError('not_editable', 409);
  const digest = await prisma.updateDigest.update({ where: { id }, data: { body_md: bodyMd } });
  await writeAudit({
    actor_user_id: actorUserId,
    action: 'update',
    table_name: 'update_digests',
    row_id: id,
    before: { body_len: before.body_md.length },
    after: { body_len: digest.body_md.length },
  });
  return digest;
}

/**
 * Finalize a DRAFT — records finalized_by/finalized_at, audited. This is the ONLY
 * state change that marks a digest ready to send; the SEND itself is a human
 * action outside Vision (locked disposition). Re-finalizing is a 409 no-op.
 */
export async function finalizeDigest(id: string, actorUserId: string): Promise<UpdateDigest> {
  const before = await prisma.updateDigest.findUnique({ where: { id } });
  if (!before) throw new UpdateDigestError('not_found', 404);
  if (before.status !== 'draft') throw new UpdateDigestError('already_finalized', 409);
  const digest = await prisma.updateDigest.update({
    where: { id },
    data: { status: 'finalized', finalized_by: actorUserId, finalized_at: new Date() },
  });
  await writeAudit({
    actor_user_id: actorUserId,
    action: 'update',
    table_name: 'update_digests',
    row_id: id,
    before: { status: 'draft' },
    after: { status: 'finalized' },
  });
  return digest;
}

// ── Copy-ready HTML render (DR3 brand — green/black, hard rule #3) ──────

const DR3_GREEN_DEEP = '#00524C';
const DR3_INK = '#1a1a1a';
const MUTED = '#5f6b69';
const HAIRLINE = '#d9e3e0';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(s: string): string {
  // Bold only (**x**), after escaping — the composer emits no other inline md.
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Minimal, deterministic markdown → HTML for the digest body: `#/##/###`
 * headings, `-`/`  -` bullets (one nesting level), and paragraphs. Everything is
 * HTML-escaped first, so a digest body can never inject markup.
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  let listDepth = 0;
  const closeLists = (to: number) => {
    while (listDepth > to) {
      out.push('</ul>');
      listDepth--;
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') {
      closeLists(0);
      continue;
    }
    if (line.startsWith('### ')) {
      closeLists(0);
      out.push(`<h3 style="color:${DR3_GREEN_DEEP};margin:16px 0 6px;font-size:15px">${inlineMd(line.slice(4))}</h3>`);
    } else if (line.startsWith('## ')) {
      closeLists(0);
      out.push(`<h2 style="color:${DR3_GREEN_DEEP};margin:20px 0 8px;font-size:18px">${inlineMd(line.slice(3))}</h2>`);
    } else if (line.startsWith('# ')) {
      closeLists(0);
      out.push(`<h1 style="color:${DR3_GREEN_DEEP};margin:0 0 10px;font-size:22px">${inlineMd(line.slice(2))}</h1>`);
    } else if (line.startsWith('> ')) {
      closeLists(0);
      out.push(`<p style="color:${MUTED};font-style:italic;border-left:3px solid ${HAIRLINE};padding-left:10px;margin:10px 0">${inlineMd(line.slice(2))}</p>`);
    } else if (/^\s{2}-\s/.test(line)) {
      if (listDepth < 2) {
        out.push('<ul style="margin:2px 0 2px 18px;padding:0">');
        listDepth = 2;
      }
      out.push(`<li style="color:${DR3_INK};font-size:14px">${inlineMd(line.replace(/^\s{2}-\s/, ''))}</li>`);
    } else if (/^-\s/.test(line)) {
      closeLists(1);
      if (listDepth < 1) {
        out.push('<ul style="margin:2px 0;padding:0 0 0 18px">');
        listDepth = 1;
      }
      out.push(`<li style="color:${DR3_INK};font-size:14px">${inlineMd(line.replace(/^-\s/, ''))}</li>`);
    } else {
      closeLists(0);
      out.push(`<p style="color:${DR3_INK};font-size:14px;margin:8px 0">${inlineMd(line)}</p>`);
    }
  }
  closeLists(0);
  return out.join('\n');
}

/** Copy-ready HTML document for a digest (DR3 brand). */
export function renderDigestHtml(digest: Pick<UpdateDigest, 'body_md'>): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f7f6">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7f6">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="640" style="width:640px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="height:6px;background:${DR3_GREEN_DEEP};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 26px 26px">
          ${mdToHtml(digest.body_md)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Label helper for a digest period (used by the review surface). */
export function digestPeriodLabel(digest: Pick<UpdateDigest, 'period_start' | 'period_end'>): string {
  return `${pacificDateLabel(digest.period_start)} → ${pacificDateLabel(digest.period_end)}`;
}
