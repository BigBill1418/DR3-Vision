// ADR-0063 — admin equipment-master data layer (closes C-27).
//
// `equipment` is the option set behind the AP Approve panel's equipment
// multi-select (ADR-0046 Amendment 5 / D-M5-6). ADR-0062 seeded 554 rows from
// the SVdP machine list but left the registry maintainable only by re-running
// `scripts/seed-equipment-master.mjs` against prod. This module is the write
// path the admin UI drives instead.
//
// Every public function here:
//   - assumes the caller already passed `requireAdmin()` — the route AND the
//     server-component layer each enforce the gate independently; this module
//     never re-derives it and never trusts a client-supplied actor id
//   - writes the mutation + its `AuditLog` row in the SAME Prisma transaction,
//     so an audit row can never be lost to a partial failure (CLAUDE.md hard
//     rule #6 — append-only retention is worthless if the row never lands)
//   - NEVER hard-deletes. `ap_equipment_links.equipment_id` is
//     `onDelete: Restrict` and those rows are financial-approval evidence.
//     `is_active=false` is the only removal.
//
// WEIGHT OF `is_active` (raised by ADR-0046 Amendment 7): the AP picker used to
// be narrowed by BOTH site and active-status. Amendment 7 made it fleet-wide —
// `listSiteEquipment()` now filters on `is_active: true` and NOTHING ELSE, and
// `assertEquipmentForSite()` likewise accepts any id that exists and is active.
// So this module's deactivate path is the ONE mechanism that removes an option
// from a financial-approval surface. A stray deactivation silently shrinks what
// an approver can cite; a stray reactivation puts a scrapped asset back in
// front of them. Treat both as money-path writes: they are audited
// (`soft_delete`/`restore`) in the same transaction as the mutation, and the
// route requires a confirm before firing deactivate.
//
// Modelled on `admin-users.ts` (ADR-0017). Deliberate divergences:
//   - `Equipment` has NO Prisma relation to `Site` (bare FK per the schema
//     comment), so site codes are resolved through an explicit id→code map
//     rather than an `include`. Two site rows exist; the extra query is free.
//   - deactivate/reactivate audit as `soft_delete`/`restore`. There is no
//     `deleted_at` column — `is_active=false` IS the soft delete here — and
//     reusing the users vocabulary keeps the audit viewer's existing labels
//     ("Soft-delete" / "Restore") accurate for this table too.

import { Prisma, type AuditAction, type Equipment, type EquipmentCategory } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  DISPLAY_NAME_MAX,
  EQUIPMENT_CATEGORIES,
  type EquipmentCategoryValue,
} from '@/app/admin/constants';

// Re-exported for server-side callers already pulling from this module. CLIENT
// components and anything they import (e.g. `admin/equipment/list-url.ts`) MUST
// import these from `@/app/admin/constants` directly — a value import from here
// drags Prisma into the browser bundle, which is the exact hazard that
// constants module exists to prevent.
export { DISPLAY_NAME_MAX, EQUIPMENT_CATEGORIES };

// Compile-time proof that the hand-declared constant and the Prisma enum stay in
// step in BOTH directions. Adding a value to `EquipmentCategory` without adding
// it to `EQUIPMENT_CATEGORIES` (or vice versa) fails the build here rather than
// silently dropping an option out of every select and filter.
type _CategoriesCoverPrisma = EquipmentCategory extends EquipmentCategoryValue ? true : never;
type _CategoriesAreAllPrisma = EquipmentCategoryValue extends EquipmentCategory ? true : never;
const _categoryParity: [_CategoriesCoverPrisma, _CategoriesAreAllPrisma] = [true, true];
void _categoryParity;

export interface AdminEquipmentDto {
  id: string;
  site_id: string;
  /** Resolved from `sites`; null only if the FK points at a row that vanished. */
  site_code: string | null;
  display_name: string;
  category: EquipmentCategory;
  is_active: boolean;
  /**
   * Count of `ap_equipment_links` rows referencing this asset. Non-zero means
   * an AP decision cites it as approval evidence, which locks `site_id`
   * (see {@link updateEquipment}).
   */
  link_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ActorContext {
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Site-code resolution
// ────────────────────────────────────────────────────────────────────

async function siteCodeById(): Promise<Map<string, string>> {
  const sites = await prisma.site.findMany({ select: { id: true, code: true } });
  return new Map(sites.map((s) => [s.id, s.code]));
}

function toDto(row: Equipment, codes: Map<string, string>, linkCount: number): AdminEquipmentDto {
  return {
    id: row.id,
    site_id: row.site_id,
    site_code: codes.get(row.site_id) ?? null,
    display_name: row.display_name,
    category: row.category,
    is_active: row.is_active,
    link_count: linkCount,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ────────────────────────────────────────────────────────────────────
// Name normalisation
// ────────────────────────────────────────────────────────────────────

/**
 * Canonical stored form of a `display_name`: trimmed, with internal whitespace
 * runs collapsed to a single space.
 *
 * This is what makes the `(site_id, display_name)` uniqueness meaningful —
 * without it `"EQ43  — Shear"` and `"EQ43 — Shear"` are distinct to Postgres
 * but identical to a human reading the approver's picker, and a future re-run
 * of `seed-equipment-master.mjs` (whose idempotency is keyed on exactly this
 * pair) would insert a duplicate instead of updating in place.
 */
export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

// ────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────

export interface EquipmentListFilters {
  siteId?: string | undefined;
  category?: EquipmentCategory | undefined;
  status?: 'active' | 'inactive' | 'all' | undefined;
  /** Case-insensitive substring match on `display_name`. */
  q?: string | undefined;
}

/**
 * The filtered registry, alphabetical by display name.
 *
 * Returns the WHOLE filtered set — there is no page window and no silent cap
 * (ADR-0063 D2: search, not pagination). The unfiltered worst case is 554 rows
 * of five short cells on an admin-only desktop surface.
 */
export async function listEquipment(
  filters: EquipmentListFilters = {},
): Promise<AdminEquipmentDto[]> {
  const where: Prisma.EquipmentWhereInput = {};
  if (filters.siteId) where.site_id = filters.siteId;
  if (filters.category) where.category = filters.category;
  if (!filters.status || filters.status === 'active') where.is_active = true;
  else if (filters.status === 'inactive') where.is_active = false;
  // 'all' adds no status filter.

  const q = filters.q?.trim();
  if (q) where.display_name = { contains: q, mode: 'insensitive' };

  const [rows, codes] = await Promise.all([
    prisma.equipment.findMany({ where, orderBy: [{ display_name: 'asc' }] }),
    siteCodeById(),
  ]);

  const counts = await linkCounts(rows.map((r) => r.id));
  return rows.map((r) => toDto(r, codes, counts.get(r.id) ?? 0));
}

/**
 * `ap_equipment_links` row counts for the given equipment ids, as a map.
 * Empty input short-circuits so an empty list never issues a `IN ()` groupBy.
 */
async function linkCounts(ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const grouped = await prisma.apEquipmentLink.groupBy({
    by: ['equipment_id'],
    where: { equipment_id: { in: [...ids] } },
    _count: { _all: true },
  });
  const out = new Map<string, number>();
  for (const g of grouped) {
    if (g.equipment_id) out.set(g.equipment_id, g._count._all);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Read by id (edit-page server hydration)
// ────────────────────────────────────────────────────────────────────

export async function getEquipment(id: string): Promise<AdminEquipmentDto | null> {
  const row = await prisma.equipment.findUnique({ where: { id } });
  if (!row) return null;
  const [codes, counts] = await Promise.all([siteCodeById(), linkCounts([row.id])]);
  return toDto(row, codes, counts.get(row.id) ?? 0);
}

// ────────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────────

export interface CreateEquipmentInput {
  site_id: string;
  display_name: string;
  category: EquipmentCategory;
  /** Defaults to true — a newly registered asset is selectable immediately. */
  is_active?: boolean | undefined;
}

export type CreateEquipmentResult =
  | { ok: true; equipment: AdminEquipmentDto }
  | { ok: false; reason: CreateFailure };

type CreateFailure = 'name_required' | 'name_too_long' | 'name_taken' | 'site_not_found';

export async function createEquipment(
  input: CreateEquipmentInput,
  actor: ActorContext,
): Promise<CreateEquipmentResult> {
  try {
    const created = await prisma.$transaction((tx) => createEquipmentInTx(tx, input, actor));
    if (!created.ok) return created;
    const codes = await siteCodeById();
    return { ok: true, equipment: toDto(created.row, codes, 0) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: 'name_taken' };
    throw e;
  }
}

/**
 * The create path as a TRANSACTION PARTICIPANT — validation, insert, and audit
 * row against a caller-supplied `tx`.
 *
 * Extracted for ADR-0046 Amendment 9 (§2.5): resolving an equipment ESCAPE-HATCH
 * request must create the asset, stamp the request resolved, and (optionally)
 * repoint the historical `ap_equipment_links` row — all or nothing. Calling
 * `createEquipment()` from inside that flow would open a SECOND, independent
 * transaction, so a failure after it committed would leave an orphan asset with
 * the request still sitting open. A nested `$transaction` cannot join an
 * enclosing one; a tx-taking function can.
 *
 * Returns the raw row rather than a DTO because `toDto` needs the site-code map
 * and link counts, which are reads the caller should do AFTER its own commit.
 *
 * The P2002 race backstop lives in the CALLERS, not here — a caught-and-swallowed
 * unique violation inside an interactive transaction would leave the tx aborted
 * but looking successful.
 */
export async function createEquipmentInTx(
  tx: Prisma.TransactionClient,
  input: CreateEquipmentInput,
  actor: ActorContext,
): Promise<{ ok: true; row: Equipment } | { ok: false; reason: CreateFailure }> {
  const display_name = normalizeDisplayName(input.display_name);
  if (!display_name) return { ok: false, reason: 'name_required' };
  if (display_name.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };

  const site = await tx.site.findUnique({ where: { id: input.site_id }, select: { id: true } });
  if (!site) return { ok: false, reason: 'site_not_found' };

  // Friendly pre-check. The DB unique index (ADR-0063 D3) is the real guard —
  // this only exists so the common case yields a readable 409 instead of a
  // raw P2002. The callers' catch closes the check-then-act race.
  const dup = await tx.equipment.findFirst({
    where: { site_id: input.site_id, display_name },
    select: { id: true },
  });
  if (dup) return { ok: false, reason: 'name_taken' };

  const row = await tx.equipment.create({
    data: {
      site_id: input.site_id,
      display_name,
      category: input.category,
      is_active: input.is_active ?? true,
    },
  });
  await tx.auditLog.create({
    data: {
      actor_user_id: actor.actorUserId,
      action: 'insert' satisfies AuditAction,
      table_name: 'equipment',
      row_id: row.id,
      before: Prisma.JsonNull,
      after: serializeForAudit(row),
      ip: actor.ip,
      user_agent: actor.userAgent,
    },
  });
  return { ok: true, row };
}

// ────────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────────

export interface UpdateEquipmentInput {
  display_name?: string | undefined;
  category?: EquipmentCategory | undefined;
  site_id?: string | undefined;
}

export type UpdateEquipmentResult =
  | { ok: true; equipment: AdminEquipmentDto }
  | { ok: false; reason: UpdateFailure };

type UpdateFailure =
  | 'not_found'
  | 'name_required'
  | 'name_too_long'
  | 'name_taken'
  | 'site_not_found';

/**
 * Edit an equipment row. Every field is mutable, including `site_id` — and
 * including on rows already cited by an AP approval.
 *
 * That is deliberate, and it reverses a lock this module shipped with earlier
 * the same day (ADR-0063 D4). The lock existed because moving a cited asset
 * would leave an approval referencing equipment the approver's SITE-FILTERED
 * picker could never have offered. ADR-0046 Amendment 7 then made the picker
 * and its validator fleet-wide: `listSiteEquipment()` and
 * `assertEquipmentForSite()` no longer read `site_id` at all. Every approver
 * sees every ACTIVE asset, so the premise is gone.
 *
 * Keeping the lock would also have been actively harmful. Site attribution
 * here is a coarse jurisdiction heuristic from the ADR-0062 seed (C-28), and
 * correcting it is a core reason this screen exists — the lock would have made
 * the most-cited assets precisely the ones nobody could fix.
 *
 * What still constrains a move: `(site_id, display_name)` uniqueness, so a
 * transfer into a site that already has that name is refused as `name_taken`.
 * Every edit — rename, re-categorise, or transfer — is captured before/after
 * in the audit log, which is what preserves the state at approval time.
 */
export async function updateEquipment(
  id: string,
  input: UpdateEquipmentInput,
  actor: ActorContext,
): Promise<UpdateEquipmentResult> {
  const existing = await prisma.equipment.findUnique({ where: { id } });
  if (!existing) return { ok: false, reason: 'not_found' };

  const data: Prisma.EquipmentUpdateInput = {};

  let nextName = existing.display_name;
  if (input.display_name !== undefined) {
    nextName = normalizeDisplayName(input.display_name);
    if (!nextName) return { ok: false, reason: 'name_required' };
    if (nextName.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };
    if (nextName !== existing.display_name) data.display_name = nextName;
  }

  let nextSiteId = existing.site_id;
  if (input.site_id !== undefined && input.site_id !== existing.site_id) {
    const site = await prisma.site.findUnique({
      where: { id: input.site_id },
      select: { id: true },
    });
    if (!site) return { ok: false, reason: 'site_not_found' };
    nextSiteId = input.site_id;
    data.site_id = nextSiteId;
  }

  if (input.category !== undefined && input.category !== existing.category) {
    data.category = input.category;
  }

  // Uniqueness is per-site, so re-check whenever EITHER half of the key moves.
  if (nextName !== existing.display_name || nextSiteId !== existing.site_id) {
    const dup = await prisma.equipment.findFirst({
      where: { site_id: nextSiteId, display_name: nextName, id: { not: id } },
      select: { id: true },
    });
    if (dup) return { ok: false, reason: 'name_taken' };
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.equipment.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          actor_user_id: actor.actorUserId,
          action: 'update' satisfies AuditAction,
          table_name: 'equipment',
          row_id: id,
          before: serializeForAudit(existing),
          after: serializeForAudit(row),
          ip: actor.ip,
          user_agent: actor.userAgent,
        },
      });
      return row;
    });
    const [codes, counts] = await Promise.all([siteCodeById(), linkCounts([id])]);
    return { ok: true, equipment: toDto(updated, codes, counts.get(id) ?? 0) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: 'name_taken' };
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────
// Deactivate / reactivate — the ONLY removal path, and (post ADR-0046
// Amendment 7) the ONLY thing that scopes the AP approver's picker at all.
//
// Both directions are money-path writes, so both are audited in the same
// transaction as the mutation and neither is ever a hard delete: the row
// survives so historical `ap_equipment_links` keep resolving. `setActive` is
// intentionally not idempotent-silent — a no-op flip still writes its audit
// row, because "an admin asserted this asset's availability at time T" is
// itself the fact worth retaining on an approval surface.
// ────────────────────────────────────────────────────────────────────

export type SetActiveResult =
  | { ok: true; equipment: AdminEquipmentDto }
  | { ok: false; reason: 'not_found' };

async function setActive(
  id: string,
  isActive: boolean,
  actor: ActorContext,
): Promise<SetActiveResult> {
  const existing = await prisma.equipment.findUnique({ where: { id } });
  if (!existing) return { ok: false, reason: 'not_found' };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.equipment.update({ where: { id }, data: { is_active: isActive } });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: (isActive ? 'restore' : 'soft_delete') satisfies AuditAction,
        table_name: 'equipment',
        row_id: id,
        before: serializeForAudit(existing),
        after: serializeForAudit(row),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return row;
  });

  const [codes, counts] = await Promise.all([siteCodeById(), linkCounts([id])]);
  return { ok: true, equipment: toDto(updated, codes, counts.get(id) ?? 0) };
}

/** Remove from the approver's picker. Reversible; the row is never deleted. */
export function deactivateEquipment(id: string, actor: ActorContext): Promise<SetActiveResult> {
  return setActive(id, false, actor);
}

export function reactivateEquipment(id: string, actor: ActorContext): Promise<SetActiveResult> {
  return setActive(id, true, actor);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

/**
 * True for a Postgres unique-constraint violation surfaced by Prisma (P2002).
 *
 * Structurally typed rather than `instanceof PrismaClientKnownRequestError`:
 * the generated client is mocked wholesale in the route tests, so an
 * `instanceof` check against the real class would never match a simulated
 * conflict and the race backstop would go untested.
 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

// Mirrors `admin-users.ts`: audit rows are written from inside an interactive
// transaction, so we can't reuse the standalone `audit.ts` helper (it runs on
// its own client). `JSON.parse(JSON.stringify(...))` ISO-stringifies the Date
// fields exactly as `writeAudit()` does. No PII scrubbing is needed — the
// equipment row carries no secrets, only asset identity.
function serializeForAudit(row: Equipment): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
}

export const __testing = { serializeForAudit, isUniqueViolation };
