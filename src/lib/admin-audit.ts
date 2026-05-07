// T-014 — admin Audit Log viewer data layer.
//
// The audit log is append-only and retained indefinitely (CLAUDE.md
// hard rule #6, ADR-0007). This module reads it; no public function
// here ever issues an UPDATE or DELETE against `audit_log`. All
// callers must already have passed `requireAdmin()` at the route /
// page layer.
//
// Cross-link strategy (per the T-014 brief): for each `(table_name,
// row_id)` pair we resolve "does this row still exist?" so the UI can
// link to a detail page when the record is alive and gracefully fall
// back to plain text when it's been hard-deleted (rare; soft-deletes
// keep the row reachable). The two tables wired today are `users` and
// `inbound_loads` — those are the only `table_name` values that
// `writeAudit()` currently emits (see grep across `src/lib`). Other
// values are tolerated and rendered as plain IDs.

import { Prisma, type AuditAction } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// ──────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'insert',
  'update',
  'delete',
  'soft_delete',
  'restore',
] as const;

// Table names we actually link out to. Adding a new entry here is the
// only change required to wire a new detail-page target. Anything not
// on this list renders as plain text + a row-id label.
export const LINKABLE_TABLES = ['users', 'inbound_loads'] as const;
export type LinkableTable = (typeof LINKABLE_TABLES)[number];

export interface AuditEntryDto {
  id: string;
  created_at: Date;
  action: AuditAction;
  table_name: string;
  row_id: string;
  // Resolved actor — either a real user (label = name + email) or a
  // system label like 'system:mymrc-scrape'. Exactly one is set.
  actor_user: { id: string; name: string; email: string | null; role: string } | null;
  actor_label: string | null;
  ip: string | null;
  user_agent: string | null;
  // The before/after blobs come straight out of Postgres. Prisma
  // returns `Prisma.JsonValue`; we widen to `unknown` at the API
  // boundary so the client renderer doesn't need the Prisma types.
  before: unknown;
  after: unknown;
  // Whether the underlying row still exists in its source table.
  // `null` when the table isn't on the LINKABLE_TABLES list.
  row_exists: boolean | null;
}

export interface AuditFilters {
  actor_user_id?: string | undefined;
  table_name?: string | undefined;
  from?: Date | undefined; // inclusive lower bound
  to?: Date | undefined; // exclusive upper bound (caller responsibility)
  actions?: AuditAction[] | undefined;
}

export interface AuditPage {
  rows: AuditEntryDto[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// ──────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

export interface ListAuditOpts {
  filters: AuditFilters;
  page: number;
  per_page: number;
}

export function clampPerPage(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw) || raw < 1) return DEFAULT_PER_PAGE;
  return Math.min(Math.floor(raw), MAX_PER_PAGE);
}

export function clampPage(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function buildWhere(f: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (f.actor_user_id) where.actor_user_id = f.actor_user_id;
  if (f.table_name) where.table_name = f.table_name;
  if (f.actions && f.actions.length > 0) where.action = { in: f.actions };
  if (f.from || f.to) {
    where.created_at = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lt: f.to } : {}),
    };
  }
  return where;
}

export async function listAuditEntries(opts: ListAuditOpts): Promise<AuditPage> {
  const per_page = clampPerPage(opts.per_page);
  const page = clampPage(opts.page);
  const where = buildWhere(opts.filters);

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        actor: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { created_at: 'desc' },
      take: per_page,
      skip: (page - 1) * per_page,
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Bulk-resolve row existence in one round-trip per table so the page
  // doesn't issue N queries. The audit log holds string PKs (uuids
  // currently), so a single `IN (...)` per table is enough.
  const grouped = new Map<LinkableTable, Set<string>>();
  for (const r of rows) {
    if ((LINKABLE_TABLES as readonly string[]).includes(r.table_name)) {
      const t = r.table_name as LinkableTable;
      let set = grouped.get(t);
      if (!set) {
        set = new Set();
        grouped.set(t, set);
      }
      set.add(r.row_id);
    }
  }
  const exists = await resolveRowExistence(grouped);

  const dtos: AuditEntryDto[] = rows.map((r) => {
    const linkable = (LINKABLE_TABLES as readonly string[]).includes(r.table_name);
    const row_exists = linkable ? (exists.get(r.table_name)?.has(r.row_id) ?? false) : null;
    return {
      id: r.id,
      created_at: r.created_at,
      action: r.action,
      table_name: r.table_name,
      row_id: r.row_id,
      actor_user: r.actor
        ? {
            id: r.actor.id,
            name: r.actor.name,
            email: r.actor.email,
            role: r.actor.role,
          }
        : null,
      actor_label: r.actor_label,
      ip: r.ip,
      user_agent: r.user_agent,
      before: r.before,
      after: r.after,
      row_exists,
    };
  });

  const total_pages = Math.max(1, Math.ceil(total / per_page));
  return { rows: dtos, total, page, per_page, total_pages };
}

async function resolveRowExistence(
  grouped: Map<LinkableTable, Set<string>>
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const [table, ids] of grouped.entries()) {
    if (ids.size === 0) continue;
    const idList = Array.from(ids);
    if (table === 'users') {
      const found = await prisma.user.findMany({
        where: { id: { in: idList } },
        select: { id: true },
      });
      out.set(table, new Set(found.map((u) => u.id)));
    } else if (table === 'inbound_loads') {
      const found = await prisma.inboundLoad.findMany({
        where: { id: { in: idList } },
        select: { id: true },
      });
      out.set(table, new Set(found.map((u) => u.id)));
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Filter-option helpers (for the dropdowns on the page)
// ──────────────────────────────────────────────────────────────────

export interface AuditActorOption {
  id: string;
  label: string; // "Bill Barnard (admin)" or "Bill Barnard <bill@…>"
}

export async function listAuditActorOptions(): Promise<AuditActorOption[]> {
  // Restrict to manager + admin since those are the only roles that
  // mutate via the admin API today; operators have a much narrower
  // mutation footprint (PIN + load self-actions). We still INCLUDE
  // operators if any audit row exists, so the picker doesn't lie.
  const users = await prisma.user.findMany({
    where: { role: { in: ['manager', 'admin'] } },
    select: { id: true, name: true, role: true, email: true },
    orderBy: [{ name: 'asc' }],
  });
  return users.map((u) => ({
    id: u.id,
    label: `${u.name} (${u.role})`,
  }));
}
