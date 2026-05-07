// T-014 — URL <-> filter-state parsing for /admin/audit.
//
// Lives in its own module so it can be unit-tested without dragging in
// Prisma. Both the server page and the client filter component import
// from here so the URL contract has exactly one source of truth.

import type { AuditAction } from '@prisma/client';
import { AUDIT_ACTIONS } from '@/lib/admin-audit';

export interface AuditUrlState {
  actor: string | null; // user id
  table: string | null; // table_name
  from: string | null; // YYYY-MM-DD
  to: string | null; // YYYY-MM-DD
  actions: AuditAction[]; // empty array = "all"
  page: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_ACTIONS = new Set<string>(AUDIT_ACTIONS);

export interface RawAuditParams {
  actor?: string | undefined;
  table?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined; // comma-separated list
  page?: string | undefined;
}

export function parseAuditParams(raw: RawAuditParams): AuditUrlState {
  const actor = raw.actor && raw.actor.length > 0 ? raw.actor : null;
  const table = raw.table && raw.table.length > 0 ? raw.table : null;
  const from = raw.from && ISO_DATE_RE.test(raw.from) ? raw.from : null;
  const to = raw.to && ISO_DATE_RE.test(raw.to) ? raw.to : null;
  const actions = parseActionList(raw.action);
  const page = parsePage(raw.page);
  return { actor, table, from, to, actions, page };
}

function parseActionList(raw: string | undefined): AuditAction[] {
  if (!raw) return [];
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const out: AuditAction[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!VALID_ACTIONS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t as AuditAction);
  }
  return out;
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function buildAuditQueryString(state: Partial<AuditUrlState>): string {
  const sp = new URLSearchParams();
  if (state.actor) sp.set('actor', state.actor);
  if (state.table) sp.set('table', state.table);
  if (state.from) sp.set('from', state.from);
  if (state.to) sp.set('to', state.to);
  if (state.actions && state.actions.length > 0) {
    sp.set('action', state.actions.join(','));
  }
  if (state.page && state.page > 1) sp.set('page', String(state.page));
  return sp.toString();
}

// Translate (from, to) ISO dates into half-open Date bounds for the
// Prisma query. `to` is inclusive day-wise from the user's perspective
// (the date picker says "to 2026-05-06"), so we widen by 24h to make
// the underlying query exclusive-end.
//
// Important: we anchor at UTC midnight, NOT local-midnight. The
// audit log stores `created_at` as `timestamptz` and the dashboard is
// served on a UTC host (CHAD-HQ). For the manager portal MVP this is
// the same boundary the loads list uses (see
// `dashboard/[site]/loads/page.tsx :: rangeToWindow`). When the
// portal i18n pass picks up a per-user TZ this helper grows a `tz`
// argument; until then keep the contract narrow.
export function isoDateBounds(
  from: string | null,
  to: string | null
): { from: Date | null; to: Date | null } {
  return {
    from: from ? parseUtcMidnight(from) : null,
    to: to ? addOneDayUtc(parseUtcMidnight(to)) : null,
  };
}

function parseUtcMidnight(s: string): Date {
  // s is YYYY-MM-DD per the regex guard. Build the Date through the
  // ISO constructor so the resulting epoch is 00:00 UTC, not 00:00
  // local — Date.parse('YYYY-MM-DD') is per-spec UTC, but explicitly
  // appending 'T00:00:00Z' makes the intent visible at the call site.
  return new Date(`${s}T00:00:00Z`);
}

function addOneDayUtc(d: Date): Date {
  return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}

// Default range: last 7 days (T-014 brief). Returns YYYY-MM-DD strings
// in UTC matching the date-picker contract above.
export function defaultDateRange(now: Date = new Date()): { from: string; to: string } {
  const today = utcDateString(now);
  const fromDate = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: utcDateString(fromDate), to: today };
}

export function utcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
