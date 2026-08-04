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
  /**
   * ADR-0075 D4 — `ap_equipment_requests` rows resolved to this asset.
   *
   * The SECOND thing a merge repoints, so the merge preview must show it or the
   * admin judges the direction of the merge on half the evidence.
   */
  resolved_request_count: number;
  /** ADR-0075 D5 — the survivor this row was merged into, or null for a live row. */
  merged_into_id: string | null;
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

function toDto(
  row: Equipment,
  codes: Map<string, string>,
  linkCount: number,
  requestCount = 0,
): AdminEquipmentDto {
  return {
    id: row.id,
    site_id: row.site_id,
    site_code: codes.get(row.site_id) ?? null,
    display_name: row.display_name,
    category: row.category,
    is_active: row.is_active,
    link_count: linkCount,
    resolved_request_count: requestCount,
    merged_into_id: row.merged_into_id,
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

/**
 * The COMPARISON form of a display name — case-folded and stripped of everything
 * that is not `[a-z0-9]`. `"Terex Machine"`, `"terex machine"` and
 * `"TEREX  MACHINE"` all canonicalise to `terexmachine`; `"EQ43 — Shear"` and
 * `"eq43 shear"` both to `eq43shear`.
 *
 * ADR-0075 D3 — this is a DETECTOR, never a constraint. It is deliberately NOT
 * backed by a case-insensitive unique index: production holds a violating pair
 * today ("Terex Machine" / "Terex machine"), migrations run in the deploy's init
 * container, and a unique index that cannot build would crash-loop the deploy
 * rather than fail a review. So the database keeps refusing only EXACT
 * `(site_id, display_name)` collisions, and this function is what lets the
 * application notice the near-misses and OFFER them, instead of silently letting
 * an operator retype around the wall.
 *
 * Its blindness is the price of that safety and is accepted: `"Terex"` and
 * `"Terex 2"` canonicalise differently and will never be suggested for each
 * other. Detection catches the typo-shaped duplicate; the merge tool catches the
 * rest.
 */
export function canonicalizeName(raw: string): string {
  return normalizeDisplayName(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** A candidate the operator can pick INSTEAD of creating a near-duplicate. */
export interface SimilarEquipment {
  id: string;
  displayName: string;
  category: EquipmentCategory;
  /** Resolved from `sites`; null only if the FK points at a row that vanished. */
  siteCode: string | null;
  isActive: boolean;
  /** Non-null means this row was already merged AWAY — never a valid target. */
  mergedIntoId: string | null;
}

/** Cap on suggestions offered. Ten is far more than a real collision produces. */
const SIMILAR_LIMIT = 10;

/**
 * Every row at `siteId` whose name canonicalises to the same form as `name` —
 * INCLUDING inactive rows and rows already merged away.
 *
 * Including both is the whole point. An operator who is about to create
 * "Terex machine" needs to see the INACTIVE "Terex Machine" (so they reactivate
 * it rather than forking it) and needs to see a MERGED one too (so the suggestion
 * list explains where the name went instead of appearing to lose it). The caller
 * decides what to do with each — `resolveEquipmentRequest` refuses a merged
 * target outright; the UI badges it.
 *
 * Canonicalisation happens in JS over the site's rows rather than in SQL, because
 * `regexp_replace` cannot use an index anyway and the registry is ~554 rows fleet-
 * wide (ADR-0063 D2 already returns whole filtered sets on this surface). That
 * keeps one canonicalisation rule in one place — a raw-SQL twin would be a second
 * definition free to drift from the one the create path checks against.
 */
export async function findSimilarEquipment(
  siteId: string,
  name: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SimilarEquipment[]> {
  const canon = canonicalizeName(name);
  if (!canon || !siteId) return [];

  const [rows, sites] = await Promise.all([
    client.equipment.findMany({
      where: { site_id: siteId },
      select: {
        id: true,
        display_name: true,
        category: true,
        is_active: true,
        merged_into_id: true,
      },
      orderBy: [{ display_name: 'asc' }],
    }),
    client.site.findMany({ select: { id: true, code: true } }),
  ]);
  const code = new Map(sites.map((s) => [s.id, s.code])).get(siteId) ?? null;

  return rows
    .filter((r) => canonicalizeName(r.display_name) === canon)
    .slice(0, SIMILAR_LIMIT)
    .map((r) => ({
      id: r.id,
      displayName: r.display_name,
      category: r.category,
      siteCode: code,
      isActive: r.is_active,
      mergedIntoId: r.merged_into_id,
    }));
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
  /**
   * ADR-0075 D5 — include rows merged INTO another asset. Default false.
   *
   * A merged loser is not a thing any more, so it does not belong in a registry
   * an admin reads as "the assets we have" — and it must not reappear in the
   * `status: 'all'` view either, which is exactly where an admin goes hunting for
   * a name they cannot find. Kept reachable behind this flag so the rows stay
   * auditable rather than invisible.
   */
  includeMerged?: boolean | undefined;
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
  // ADR-0075 D5 — merged losers drop out of EVERY status view by default,
  // including 'all'. See `EquipmentListFilters.includeMerged`.
  if (!filters.includeMerged) where.merged_into_id = null;

  const q = filters.q?.trim();
  if (q) where.display_name = { contains: q, mode: 'insensitive' };

  const [rows, codes] = await Promise.all([
    prisma.equipment.findMany({ where, orderBy: [{ display_name: 'asc' }] }),
    siteCodeById(),
  ]);

  const ids = rows.map((r) => r.id);
  const [counts, requestCounts] = await Promise.all([linkCounts(ids), resolvedRequestCounts(ids)]);
  return rows.map((r) => toDto(r, codes, counts.get(r.id) ?? 0, requestCounts.get(r.id) ?? 0));
}

/**
 * `ap_equipment_requests` counts per resolved asset, as a map.
 *
 * Mirrors {@link linkCounts}: one grouped query for the whole page, and an empty
 * input short-circuits so an empty list never issues an `IN ()` groupBy.
 */
async function resolvedRequestCounts(ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const grouped = await prisma.apEquipmentRequest.groupBy({
    by: ['resolved_equipment_id'],
    where: { resolved_equipment_id: { in: [...ids] } },
    _count: { _all: true },
  });
  const out = new Map<string, number>();
  for (const g of grouped) {
    if (g.resolved_equipment_id) out.set(g.resolved_equipment_id, g._count._all);
  }
  return out;
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
  | CreateEquipmentFailure;

/**
 * ADR-0075 D2 — `name_taken` carries the row it collided WITH.
 *
 * A refusal that names no alternative is what produced the three-row Terex split:
 * the operator was told the name was in use, was given nothing to click, and
 * retyped around it. `existing` is what turns the wall into a fork — the caller
 * can offer "use this one" instead of only "pick another name". Optional so the
 * other three reasons keep their shape and every existing consumer that reads
 * `.reason` is unchanged.
 */
export interface CreateEquipmentFailure {
  ok: false;
  reason: CreateFailure;
  existing?: SimilarEquipment[];
}

export type CreateFailure = 'name_required' | 'name_too_long' | 'name_taken' | 'site_not_found';

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
): Promise<{ ok: true; row: Equipment } | CreateEquipmentFailure> {
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
  if (dup) {
    // ADR-0075 D2 — hand back WHAT it collided with, not just THAT it collided.
    // The canonical lookup is deliberately wider than the exact match that
    // tripped us: typing "Terex Machine" at a site that holds both "Terex
    // Machine" and "Terex machine" should surface both, because picking the
    // wrong one of those is how the split got worse. Reads only; the enclosing
    // transaction is still clean and the caller is free to roll it back.
    const existing = await findSimilarEquipment(input.site_id, display_name, tx);
    return { ok: false, reason: 'name_taken', existing };
  }

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
// Merge (ADR-0075 D4) — collapse near-duplicates onto one survivor.
//
// WHAT A MERGE MOVES: attribution, and ONLY attribution. Two tables point at an
// equipment row — `ap_equipment_links.equipment_id` (which invoice cited which
// asset) and `ap_equipment_requests.resolved_equipment_id` (which escape-hatch
// request became which asset). Both are repointed at the winner.
//
// WHAT A MERGE MUST NEVER TOUCH: `ap_requests`. Not `status`, not the amounts,
// not `decided_by` / `decided_at`. The money already moved and the approval
// already happened; a bookkeeping correction to WHICH machine an invoice names
// cannot be allowed to reach back into the decision itself. That is the same
// invariant `resolveEquipmentRequest` holds (ADR-0046 Amendment 9 #3), and the
// merge test asserts it by proving `apRequest.update` / `updateMany` are never
// called at all — a comment cannot enforce it, so a test does.
//
// `equipment_events` is out of the blast radius by construction: it is a
// Terex-first LOG keyed on a free-text `equipment_code` string with no FK into
// this registry (ADR-0048 D3), so nothing there references an equipment id and
// nothing there needs repointing.
//
// The loser is KEPT — deactivated and stamped, never deleted. Same rule as the
// rest of this module: `ap_equipment_links.equipment_id` is `onDelete: Restrict`
// and those rows are financial-approval evidence.
// ────────────────────────────────────────────────────────────────────

export type MergeFailure =
  | 'not_found'
  | 'same_row'
  | 'cross_site'
  | 'winner_merged'
  | 'loser_merged';

export type MergeEquipmentResult =
  | {
      ok: true;
      winner: AdminEquipmentDto;
      /** `ap_equipment_links` rows repointed at the winner. */
      repointedLinks: number;
      /** `ap_equipment_requests.resolved_equipment_id` values repointed. */
      repointedRequests: number;
    }
  | { ok: false; reason: MergeFailure };

/**
 * Merge `loserId` into `winnerId`: repoint both attribution tables, deactivate
 * and stamp the loser, audit the whole thing in ONE transaction.
 *
 * Refused outright when the two ids are the same row, when they sit at different
 * sites (a merge is a de-duplication within a site's registry, never a cross-
 * jurisdiction move — CLAUDE.md hard rule #2; the admin can transfer the site
 * first with {@link updateEquipment} if that is really the intent), or when
 * EITHER side has already been merged away (chaining merges would make
 * `merged_into_id` a linked list nothing follows correctly, and the seed guard
 * only walks one hop).
 *
 * Every guard re-reads its row INSIDE the transaction. Checking first and acting
 * later would let two admins merge A→B and B→A concurrently and leave a cycle
 * that no consumer's `merged_into_id IS NULL` filter can escape.
 */
export async function mergeEquipment(
  winnerId: string,
  loserId: string,
  actor: ActorContext,
): Promise<MergeEquipmentResult> {
  if (winnerId === loserId) return { ok: false, reason: 'same_row' };

  const outcome = await prisma.$transaction(async (tx) => {
    const [winner, loser] = await Promise.all([
      tx.equipment.findUnique({ where: { id: winnerId } }),
      tx.equipment.findUnique({ where: { id: loserId } }),
    ]);
    if (!winner || !loser) return { ok: false, reason: 'not_found' } as const;
    if (winner.site_id !== loser.site_id) return { ok: false, reason: 'cross_site' } as const;
    if (winner.merged_into_id) return { ok: false, reason: 'winner_merged' } as const;
    if (loser.merged_into_id) return { ok: false, reason: 'loser_merged' } as const;

    const links = await tx.apEquipmentLink.updateMany({
      where: { equipment_id: loserId },
      data: { equipment_id: winnerId },
    });
    const requests = await tx.apEquipmentRequest.updateMany({
      where: { resolved_equipment_id: loserId },
      data: { resolved_equipment_id: winnerId },
    });

    const stamped = await tx.equipment.update({
      where: { id: loserId },
      data: {
        is_active: false,
        merged_into_id: winnerId,
        merged_by: actor.actorUserId,
        merged_at: new Date(),
      },
    });

    // Audit INSIDE the transaction (CLAUDE.md hard rule #6). Filed against the
    // LOSER's row id, because the loser is the row whose state changed; the
    // winner gained references but not a single column. The repoint counts ride
    // in `after` so the audit alone answers "what moved" without re-deriving it
    // from tables that have since moved on.
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.actorUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'equipment',
        row_id: loserId,
        before: serializeForAudit(loser),
        after: {
          ...(serializeForAudit(stamped) as Record<string, unknown>),
          merged_into_display_name: winner.display_name,
          repointed_links: links.count,
          repointed_equipment_requests: requests.count,
        } as Prisma.InputJsonValue,
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });

    return {
      ok: true,
      winnerRow: winner,
      repointedLinks: links.count,
      repointedRequests: requests.count,
    } as const;
  });

  if (!outcome.ok) return outcome;

  const [codes, counts] = await Promise.all([siteCodeById(), linkCounts([winnerId])]);
  return {
    ok: true,
    winner: toDto(outcome.winnerRow, codes, counts.get(winnerId) ?? 0),
    repointedLinks: outcome.repointedLinks,
    repointedRequests: outcome.repointedRequests,
  };
}

/**
 * How many rows would move if this asset were merged away — the numbers the
 * admin sees BEFORE confirming, for each side.
 *
 * Two reads, no writes. Shown per-side so the direction of the merge is an
 * informed choice: the row with the invoices behind it is usually the one that
 * should survive.
 */
export async function equipmentReferenceCounts(
  id: string,
): Promise<{ links: number; requests: number }> {
  const [links, requests] = await Promise.all([
    prisma.apEquipmentLink.count({ where: { equipment_id: id } }),
    prisma.apEquipmentRequest.count({ where: { resolved_equipment_id: id } }),
  ]);
  return { links, requests };
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
