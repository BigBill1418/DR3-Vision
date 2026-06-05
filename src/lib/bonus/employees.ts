// ADR-0019 §9 — Bonus employee (Woodland processor) data layer.
//
// Every public function here:
//   - assumes the caller already passed `requireBonusAccess()` (the route /
//     server-component layer enforces the Woodland gate; never trust the
//     client). Callers pass the Woodland `siteId` from the BonusContext, and
//     EVERY query is scoped by it (CLAUDE.md hard rule #2 — bonus is
//     Woodland-only in V2).
//   - writes the mutation + an AuditLog row in the SAME Prisma transaction so
//     an audit row can never be lost on partial failure (CLAUDE.md hard rule
//     #6 — append-only retention is useless if the row never lands). The
//     `table_name` is always 'bonus_employees'.
//
// ADR-0019 §9a (rehire): adding an employee whose `full_name` matches a
// soft-deleted / inactive record does NOT create a duplicate — `createEmployee`
// returns a `rehire_candidate` signal carrying the existing row so the UI can
// prompt "Reactivate {name} (deactivated {date})?". `reactivateEmployee` is the
// distinct action that path resolves to.
//
// ADR-0019 §9b (name change): `renameEmployee` updates `full_name` (which drives
// display everywhere) and appends the PREVIOUS name to the `previous_names`
// JSONB array as `{ name, changed_at }`. The before/after snapshots land in the
// audit log so the full rename history is reconstructable from two sources.

import { Prisma, type AuditAction, type BonusEmployee } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// ────────────────────────────────────────────────────────────────────
// DTO
// ────────────────────────────────────────────────────────────────────

export interface PreviousName {
  name: string;
  changed_at: string; // ISO timestamp
}

export interface BonusEmployeeDto {
  id: string;
  site_id: string;
  full_name: string;
  previous_names: PreviousName[];
  is_active: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface ActorContext {
  actorUserId: string;
  actorLabel?: string | null;
  ip: string | null;
  userAgent: string | null;
}

function parsePreviousNames(raw: BonusEmployee['previous_names']): PreviousName[] {
  if (!Array.isArray(raw)) return [];
  const out: PreviousName[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const name = rec['name'];
      const changedAt = rec['changed_at'];
      if (typeof name === 'string' && typeof changedAt === 'string') {
        out.push({ name, changed_at: changedAt });
      }
    }
  }
  return out;
}

function toDto(e: BonusEmployee): BonusEmployeeDto {
  return {
    id: e.id,
    site_id: e.site_id,
    full_name: e.full_name,
    previous_names: parsePreviousNames(e.previous_names),
    is_active: e.is_active,
    notes: e.notes,
    created_at: e.created_at,
    updated_at: e.updated_at,
    deleted_at: e.deleted_at,
  };
}

// Audit serializer. Mirrors `writeAudit()` / `admin-users.ts`: Date instances
// ISO-stringify via JSON round-trip, matching the audit-table behavior. Kept
// local so we can write the audit row from inside an interactive transaction.
function serializeForAudit(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

// ────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────

export type EmployeeStatusFilter = 'active' | 'inactive' | 'all';
export type EmployeeSort = 'name' | 'status';

export interface ListEmployeesFilters {
  status?: EmployeeStatusFilter | undefined;
  sort?: EmployeeSort | undefined;
}

export async function listEmployees(
  siteId: string,
  filters: ListEmployeesFilters = {},
): Promise<BonusEmployeeDto[]> {
  const where: Prisma.BonusEmployeeWhereInput = { site_id: siteId };
  const status = filters.status ?? 'active';
  if (status === 'active') where.is_active = true;
  else if (status === 'inactive') where.is_active = false;
  // 'all' adds no status filter.

  // Sort by status puts active rows first, then by name within each group; the
  // name sort is always the tiebreaker so the list is deterministic.
  const orderBy: Prisma.BonusEmployeeOrderByWithRelationInput[] =
    filters.sort === 'status'
      ? [{ is_active: 'desc' }, { full_name: 'asc' }]
      : [{ full_name: 'asc' }];

  const rows = await prisma.bonusEmployee.findMany({ where, orderBy });
  return rows.map(toDto);
}

// ────────────────────────────────────────────────────────────────────
// Create (with ADR-0019 §9a rehire detection)
// ────────────────────────────────────────────────────────────────────

export interface CreateEmployeeInput {
  full_name: string;
  notes?: string | null;
}

export type CreateEmployeeResult =
  | { ok: true; employee: BonusEmployeeDto }
  | { ok: false; reason: 'name_required' }
  | { ok: false; reason: 'name_taken'; employee: BonusEmployeeDto }
  | { ok: false; reason: 'rehire_candidate'; employee: BonusEmployeeDto };

/**
 * Find an existing employee at this site whose `full_name` matches
 * case-insensitively (trimmed). Used for the §9a rehire path; we can't rely on
 * a DB unique index because names legitimately repeat across soft-deleted rows.
 */
async function findByName(siteId: string, fullName: string): Promise<BonusEmployee | null> {
  const target = fullName.trim().toLowerCase();
  const candidates = await prisma.bonusEmployee.findMany({ where: { site_id: siteId } });
  return candidates.find((c) => c.full_name.trim().toLowerCase() === target) ?? null;
}

export async function createEmployee(
  siteId: string,
  input: CreateEmployeeInput,
  actor: ActorContext,
): Promise<CreateEmployeeResult> {
  const fullName = input.full_name.trim();
  if (!fullName) return { ok: false, reason: 'name_required' };

  // ADR-0019 §9a: a name match flips create into a rehire prompt (if the match
  // is inactive) or a hard conflict (if the match is already active).
  const existing = await findByName(siteId, fullName);
  if (existing) {
    if (existing.is_active) return { ok: false, reason: 'name_taken', employee: toDto(existing) };
    return { ok: false, reason: 'rehire_candidate', employee: toDto(existing) };
  }

  const created = await prisma.$transaction(async (tx) => {
    const e = await tx.bonusEmployee.create({
      data: {
        site_id: siteId,
        full_name: fullName,
        notes: input.notes ?? null,
        previous_names: [],
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        actor_label: actor.actorLabel ?? null,
        action: 'insert' satisfies AuditAction,
        table_name: 'bonus_employees',
        row_id: e.id,
        before: Prisma.JsonNull,
        after: serializeForAudit(toDto(e)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return e;
  });

  return { ok: true, employee: toDto(created) };
}

// ────────────────────────────────────────────────────────────────────
// Rename (ADR-0019 §9b)
// ────────────────────────────────────────────────────────────────────

export type RenameEmployeeResult =
  | { ok: true; employee: BonusEmployeeDto }
  | { ok: false; reason: 'not_found' | 'name_required' | 'name_taken' };

export async function renameEmployee(
  siteId: string,
  id: string,
  newName: string,
  actor: ActorContext,
): Promise<RenameEmployeeResult> {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: 'name_required' };

  const existing = await prisma.bonusEmployee.findFirst({ where: { id, site_id: siteId } });
  if (!existing) return { ok: false, reason: 'not_found' };

  // No-op rename (same name modulo whitespace) is allowed but writes nothing.
  if (existing.full_name === trimmed) return { ok: true, employee: toDto(existing) };

  // A different ACTIVE employee already using the target name is a conflict.
  const collision = await findByName(siteId, trimmed);
  if (collision && collision.id !== id && collision.is_active) {
    return { ok: false, reason: 'name_taken' };
  }

  // ADR-0019 §9b: append the OUTGOING name to previous_names with a timestamp.
  const history = parsePreviousNames(existing.previous_names);
  history.push({ name: existing.full_name, changed_at: new Date().toISOString() });

  const updated = await prisma.$transaction(async (tx) => {
    const e = await tx.bonusEmployee.update({
      where: { id },
      data: {
        full_name: trimmed,
        previous_names: history as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        actor_label: actor.actorLabel ?? null,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_employees',
        row_id: id,
        before: serializeForAudit(toDto(existing)),
        after: serializeForAudit(toDto(e)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return e;
  });

  return { ok: true, employee: toDto(updated) };
}

// ────────────────────────────────────────────────────────────────────
// Deactivate (soft delete) / Reactivate (rehire, ADR-0019 §9a)
// ────────────────────────────────────────────────────────────────────

export type DeactivateEmployeeResult =
  | { ok: true; employee: BonusEmployeeDto }
  | { ok: false; reason: 'not_found' | 'already_inactive' };

export async function deactivateEmployee(
  siteId: string,
  id: string,
  actor: ActorContext,
): Promise<DeactivateEmployeeResult> {
  const existing = await prisma.bonusEmployee.findFirst({ where: { id, site_id: siteId } });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!existing.is_active) return { ok: false, reason: 'already_inactive' };

  const updated = await prisma.$transaction(async (tx) => {
    const e = await tx.bonusEmployee.update({
      where: { id },
      data: { is_active: false, deleted_at: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        actor_label: actor.actorLabel ?? null,
        action: 'soft_delete' satisfies AuditAction,
        table_name: 'bonus_employees',
        row_id: id,
        before: serializeForAudit(toDto(existing)),
        after: serializeForAudit(toDto(e)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return e;
  });

  return { ok: true, employee: toDto(updated) };
}

export type ReactivateEmployeeResult =
  | { ok: true; employee: BonusEmployeeDto }
  | { ok: false; reason: 'not_found' | 'already_active' };

export async function reactivateEmployee(
  siteId: string,
  id: string,
  actor: ActorContext,
): Promise<ReactivateEmployeeResult> {
  const existing = await prisma.bonusEmployee.findFirst({ where: { id, site_id: siteId } });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.is_active) return { ok: false, reason: 'already_active' };

  const updated = await prisma.$transaction(async (tx) => {
    const e = await tx.bonusEmployee.update({
      where: { id },
      data: { is_active: true, deleted_at: null },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        actor_label: actor.actorLabel ?? null,
        action: 'restore' satisfies AuditAction,
        table_name: 'bonus_employees',
        row_id: id,
        before: serializeForAudit(toDto(existing)),
        after: serializeForAudit(toDto(e)),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return e;
  });

  return { ok: true, employee: toDto(updated) };
}

// ────────────────────────────────────────────────────────────────────
// Read by id (for edit hydration)
// ────────────────────────────────────────────────────────────────────

export async function getEmployee(siteId: string, id: string): Promise<BonusEmployeeDto | null> {
  const e = await prisma.bonusEmployee.findFirst({ where: { id, site_id: siteId } });
  return e ? toDto(e) : null;
}

// Re-export internals tests need to drive without a DB.
export const __testing = { parsePreviousNames, serializeForAudit };
