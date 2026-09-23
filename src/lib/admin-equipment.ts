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
  DETAILS_MAX,
  DISPLAY_NAME_MAX,
  EQUIPMENT_CATEGORIES,
  MAKE_MAX,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  UNIT_NUMBER_MAX,
  VIN_SERIAL_MAX,
  assetTypeDef,
  type EquipmentCategoryValue,
} from '@/app/admin/constants';
import {
  generateDisplayName,
  matchEquipment,
  nameKey,
  pickerMatches,
  probableDuplicates,
  unitKey,
  type MatchQuery,
  type MatchReason,
  type MatchableEquipment,
} from '@/lib/equipment/match';

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
  /** ADR-0135 — null means FLEET-WIDE: the asset has no home yard. */
  site_id: string | null;
  /** Resolved from `sites`; null for a fleet-wide asset (or a vanished FK). */
  site_code: string | null;
  display_name: string;
  category: EquipmentCategory;
  is_active: boolean;
  /** ADR-0135 D — structured identity, null on legacy free-text rows. */
  unit_number: string | null;
  make: string | null;
  asset_type: string | null;
  vin_serial: string | null;
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

/**
 * ADR-0077 — an autonomous actor with no `users.id` behind it.
 *
 * Mirrors `SystemActor` in `src/lib/survey/types.ts` (ADR-0036) and the
 * `actor_label` convention already used by the mymrc bridges, the AP poll and
 * `notifyStaff`: a non-human write NAMES ITSELF in `audit_log.actor_label`
 * rather than borrowing a person's id. Borrowing one would put a false claim
 * into an append-only table (CLAUDE.md hard rule #6) — the audit row would read
 * as though that person clicked Merge.
 *
 * `merged_by` / `resolved_by`-style user FKs are left NULL for this actor; the
 * label is the record of who acted, and it is the only place that record lives.
 */
export interface SystemActorContext {
  /** e.g. `'system:terex-canonical-merge'`. Never a person's name. */
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
}

/** Either a signed-in admin or a named autonomous actor. */
export type AnyActorContext = ActorContext | SystemActorContext;

/** Narrow on the discriminating property, exactly as `survey/campaigns.ts` does. */
function isSystemActor(actor: AnyActorContext): actor is SystemActorContext {
  return 'actorLabel' in actor;
}

/** The four audit columns that describe WHO acted, for either actor shape. */
function actorAuditFields(actor: AnyActorContext): {
  actor_user_id: string | null;
  actor_label: string | null;
  ip: string | null;
  user_agent: string | null;
} {
  return {
    actor_user_id: isSystemActor(actor) ? null : actor.actorUserId,
    actor_label: isSystemActor(actor) ? actor.actorLabel : null,
    ip: actor.ip,
    user_agent: actor.userAgent,
  };
}

/** The `users.id` to stamp on a row's own actor FK — NULL for a system actor. */
function actorUserIdOrNull(actor: AnyActorContext): string | null {
  return isSystemActor(actor) ? null : actor.actorUserId;
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
    site_code: row.site_id ? (codes.get(row.site_id) ?? null) : null,
    display_name: row.display_name,
    category: row.category,
    is_active: row.is_active,
    unit_number: row.unit_number,
    make: row.make,
    asset_type: row.asset_type,
    vin_serial: row.vin_serial,
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
 * `"TEREX  MACHINE"` all canonicalise to `terexmachine`.
 *
 * ADR-0135 — this is now ONE of the matcher's signals (`nameKey` in
 * `@/lib/equipment/match`), not the whole detector. Comparing whole names is
 * what let `161053.` sit next to `161053 — Freightliner Semi Truck`; the matcher
 * adds the unit number, the VIN and fleet-wide scope. The database now also
 * refuses a live name that differs only by case/whitespace
 * (`equipment_live_name_ci_key`, ADR-0135 G) — ADR-0075 D3's blocker (a live
 * violating pair) was cleared by the ADR-0135 §5 cleanup.
 */
export function canonicalizeName(raw: string): string {
  return nameKey(normalizeDisplayName(raw));
}

/** A candidate the operator can pick INSTEAD of creating a near-duplicate. */
export interface SimilarEquipment {
  id: string;
  displayName: string;
  category: EquipmentCategory;
  /** ADR-0135 — null for a fleet-wide asset. */
  siteId: string | null;
  /** Resolved from `sites`; null for a fleet-wide asset. */
  siteCode: string | null;
  isActive: boolean;
  /** Non-null means this row was already merged AWAY — never a valid target. */
  mergedIntoId: string | null;
  unitNumber: string | null;
  /** Why the matcher surfaced it. */
  reason: MatchReason;
  /** True when creating a new asset next to this one would probably duplicate it. */
  probableDuplicate: boolean;
}

/** Cap on suggestions offered by the typeahead. */
const SIMILAR_LIMIT = 10;

type Client = Prisma.TransactionClient | typeof prisma;

type RegistryRow = MatchableEquipment & { category: EquipmentCategory; siteCode: string | null };

/**
 * The WHOLE registry in matcher shape — every site, every status, merged rows
 * included (the matcher follows a merged loser to its survivor, so an old
 * spelling still finds the live asset).
 *
 * In JS rather than SQL, as ADR-0075 argued and ADR-0135 H re-affirms: the
 * registry is ~580 rows, `pg_trgm` is not installed, and one matcher in one
 * language is one definition that the server gate and both UIs share.
 */
async function loadRegistry(client: Client): Promise<RegistryRow[]> {
  const [rows, sites] = await Promise.all([
    client.equipment.findMany({
      select: {
        id: true,
        display_name: true,
        category: true,
        site_id: true,
        is_active: true,
        merged_into_id: true,
        unit_number: true,
        vin_serial: true,
        asset_type: true,
      },
      orderBy: [{ display_name: 'asc' }],
    }),
    client.site.findMany({ select: { id: true, code: true } }),
  ]);
  const code = new Map(sites.map((s) => [s.id, s.code]));
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    category: r.category,
    siteId: r.site_id,
    siteCode: r.site_id ? (code.get(r.site_id) ?? null) : null,
    isActive: r.is_active,
    mergedIntoId: r.merged_into_id,
    unitNumber: r.unit_number,
    vinSerial: r.vin_serial,
    assetType: r.asset_type,
  }));
}

function toSimilar(m: {
  row: RegistryRow;
  reason: MatchReason;
  probableDuplicate: boolean;
}): SimilarEquipment {
  return {
    id: m.row.id,
    displayName: m.row.displayName,
    category: m.row.category,
    siteId: m.row.siteId,
    siteCode: m.row.siteCode,
    isActive: m.row.isActive,
    mergedIntoId: m.row.mergedIntoId,
    unitNumber: m.row.unitNumber ?? null,
    reason: m.reason,
    probableDuplicate: m.probableDuplicate,
  };
}

/**
 * ADR-0135 A/B — search the WHOLE fleet for what the person typed, ranked:
 * VIN, same name, same unit number, then shared words. Both sites, because
 * trailers move between yards and the old per-site lookup (`site_id` filter)
 * could not see 281577 at Woodland from Eugene.
 *
 * This is the resolve panel's "Find it in the fleet" and the typeahead's
 * "already in the fleet?" — one function. Inactive rows are returned (so a
 * returning asset is reactivated, not re-created); merged rows are replaced by
 * their survivor.
 */
export async function searchEquipment(
  query: MatchQuery,
  opts: { limit?: number | undefined; includeWordMatches?: boolean | undefined } = {},
  client: Client = prisma,
): Promise<SimilarEquipment[]> {
  const rows = await loadRegistry(client);
  return matchEquipment(query, rows, {
    limit: opts.limit ?? SIMILAR_LIMIT,
    includeWordMatches: opts.includeWordMatches,
  }).map(toSimilar);
}

/**
 * Back-compat name for the ADR-0075 lookup: the probable duplicates of a name,
 * fleet-wide. Word-only matches are excluded — a shared word is a search hit,
 * never a collision.
 */
export async function findSimilarEquipment(
  query: MatchQuery | string,
  client: Client = prisma,
): Promise<SimilarEquipment[]> {
  const q = typeof query === 'string' ? { text: query } : query;
  return searchEquipment(q, { includeWordMatches: false }, client);
}

// ────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────

/** `EquipmentListFilters.siteId` value that lists only fleet-wide (no-yard) assets. */
export const FLEET_SITE_FILTER = 'fleet';

export interface EquipmentListFilters {
  /** A `sites.id` (that yard + fleet-wide rows), or {@link FLEET_SITE_FILTER}. */
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
  // ADR-0135 — a fleet-wide asset (site_id NULL) belongs to EVERY yard, so a
  // site-filtered list shows it too; `'fleet'` lists only the fleet-wide rows.
  if (filters.siteId === FLEET_SITE_FILTER) where.site_id = null;
  else if (filters.siteId) where.OR = [{ site_id: filters.siteId }, { site_id: null }];
  if (filters.category) where.category = filters.category;
  if (!filters.status || filters.status === 'active') where.is_active = true;
  else if (filters.status === 'inactive') where.is_active = false;
  // 'all' adds no status filter.
  // ADR-0075 D5 — merged losers drop out of EVERY status view by default,
  // including 'all'. See `EquipmentListFilters.includeMerged`.
  if (!filters.includeMerged) where.merged_into_id = null;

  const q = filters.q?.trim();

  const [allRows, codes] = await Promise.all([
    prisma.equipment.findMany({ where, orderBy: [{ display_name: 'asc' }] }),
    siteCodeById(),
  ]);
  // ADR-0135 B — the SAME unit-aware filter as the approver's picker, instead of
  // a SQL `ILIKE`: `trailer # 19` finds `Trailer #19`, `161053.` finds
  // `161053 — Freightliner …`, and `48-68` does NOT find `4868`.
  const rows = q ? allRows.filter((r) => pickerMatches(q, r.display_name)) : allRows;

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
  /** A `sites.id`, or null for a FLEET-WIDE asset (ADR-0135). */
  site_id: string | null;
  /**
   * Free-text name — LEGACY / system callers only. When `asset_type` is given the
   * name is GENERATED from the structured fields and this is ignored (ADR-0135 D:
   * people stop typing names).
   */
  display_name?: string | undefined;
  /** Required unless `asset_type` implies it. */
  category?: EquipmentCategory | undefined;
  /** Defaults to true — a newly registered asset is selectable immediately. */
  is_active?: boolean | undefined;

  // ── ADR-0135 D — the structured form ──────────────────────────────────────
  /** One of `ASSET_TYPES[].value`. Present = structured create. */
  asset_type?: string | undefined;
  unit_number?: string | undefined;
  make?: string | undefined;
  /** Descriptive words for the generated name (`48 Ft Swing Door`). Not stored. */
  details?: string | undefined;
  vin_serial?: string | undefined;

  /**
   * ADR-0135 C — the door in the wall. The caller asserts the new asset is
   * DIFFERENT from every probable duplicate the gate found, and says why. The
   * reason, the actor and the rows it was judged against are written to the
   * create's audit row and to `equipment_distinct_pairs`.
   */
  confirm_distinct?:
    | {
        reason: string;
        /** Must include EVERY probable-duplicate id the gate returned — proof they were shown. */
        distinct_from_ids: string[];
      }
    | undefined;
}

export type CreateEquipmentResult =
  | { ok: true; equipment: AdminEquipmentDto }
  | CreateEquipmentFailure;

/**
 * ADR-0075 D2 / ADR-0135 C — a refusal carries the rows it refused ON.
 *
 * A refusal that names no alternative is what produced the three-row Terex split:
 * the operator was told the name was in use, was given nothing to click, and
 * retyped around it. `existing` turns the wall into a fork.
 */
export interface CreateEquipmentFailure {
  ok: false;
  reason: CreateFailure;
  existing?: SimilarEquipment[];
}

export type CreateFailure =
  | 'name_required'
  | 'name_too_long'
  | 'name_taken'
  /** ADR-0135 — another live asset already carries this VIN / serial. */
  | 'vin_taken'
  | 'site_not_found'
  /** ADR-0135 C — a live row probably IS this asset; override with a reason, or use it. */
  | 'probable_duplicate'
  /** ADR-0135 C — override sent without a real reason. */
  | 'override_reason_required'
  /** ADR-0135 C — override did not name every probable duplicate (they were not all shown). */
  | 'override_incomplete'
  /** ADR-0135 D — structured-create field problems. */
  | 'asset_type_invalid'
  | 'unit_number_required'
  | 'unit_number_invalid'
  | 'field_too_long'
  | 'category_required';

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

/** The structured fields, validated and normalised — or the reason they are not. */
type ResolvedFields =
  | {
      ok: true;
      display_name: string;
      category: EquipmentCategory;
      unit_number: string | null;
      make: string | null;
      asset_type: string | null;
      vin_serial: string | null;
    }
  | { ok: false; reason: CreateFailure };

function tidy(v: string | undefined): string {
  return (v ?? '').trim().replace(/\s+/g, ' ');
}

/** ADR-0135 D — derive the row's identity from either the structured form or a legacy name. */
export function resolveCreateFields(input: CreateEquipmentInput): ResolvedFields {
  const unit = tidy(input.unit_number);
  const make = tidy(input.make);
  const details = tidy(input.details);
  const vin = tidy(input.vin_serial).toUpperCase();
  if (
    unit.length > UNIT_NUMBER_MAX ||
    make.length > MAKE_MAX ||
    details.length > DETAILS_MAX ||
    vin.length > VIN_SERIAL_MAX
  ) {
    return { ok: false, reason: 'field_too_long' };
  }
  // A unit number is ONE unit: `5327`, `32-48`, `EQ24`. `53489, 5340, 35` is a
  // work order covering four trailers (ADR-0135 §6.6), and `trailer 5327` is a
  // name, not a number.
  if (
    unit &&
    (unitKey(unit) === '' || /[,;/&]|\band\b/i.test(unit) || /\s/.test(unit.replace(/^#\s*/, '')))
  ) {
    return { ok: false, reason: 'unit_number_invalid' };
  }

  if (input.asset_type !== undefined) {
    const def = assetTypeDef(input.asset_type);
    if (!def) return { ok: false, reason: 'asset_type_invalid' };
    if (def.unitRequired && !unit) return { ok: false, reason: 'unit_number_required' };
    const display_name = generateDisplayName({
      unitNumber: unit.replace(/^#\s*/, ''),
      make,
      details,
      assetType: def.label,
    });
    if (display_name.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };
    return {
      ok: true,
      display_name,
      category: def.category,
      unit_number: unit ? unit.replace(/^#\s*/, '') : null,
      make: make || null,
      asset_type: def.value,
      vin_serial: vin || null,
    };
  }

  const display_name = normalizeDisplayName(input.display_name ?? '');
  if (!display_name) return { ok: false, reason: 'name_required' };
  if (display_name.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };
  if (!input.category) return { ok: false, reason: 'category_required' };
  return {
    ok: true,
    display_name,
    category: input.category,
    unit_number: unit ? unit.replace(/^#\s*/, '') : null,
    make: make || null,
    asset_type: null,
    vin_serial: vin || null,
  };
}

/**
 * The create path as a TRANSACTION PARTICIPANT — validation, the ADR-0135 gate,
 * insert, and audit row against a caller-supplied `tx`.
 *
 * Extracted for ADR-0046 Amendment 9 (§2.5): resolving an equipment ESCAPE-HATCH
 * request must create the asset, stamp the request resolved, and (optionally)
 * repoint the historical `ap_equipment_links` row — all or nothing.
 *
 * ADR-0135 C — THE HARD GATE. Before inserting, the whole fleet is run through
 * the shared matcher. Any PROBABLE DUPLICATE (same VIN, same name ignoring
 * case/punctuation, or same unit number — see `probableDuplicates`) refuses the
 * create with the rows it matched, unless the caller sends `confirm_distinct`
 * naming every one of them with a reason. An identical name (case/whitespace
 * only) is NOT overridable: two live assets cannot share a name the approver's
 * picker would render identically, and the database refuses it anyway
 * (`equipment_live_name_ci_key`).
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
  const fields = resolveCreateFields(input);
  if (!fields.ok) return { ok: false, reason: fields.reason };

  if (input.site_id !== null) {
    const site = await tx.site.findUnique({ where: { id: input.site_id }, select: { id: true } });
    if (!site) return { ok: false, reason: 'site_not_found' };
  }

  const registry = await loadRegistry(tx);
  const dups = probableDuplicates(
    {
      text: fields.display_name,
      unitNumber: fields.unit_number,
      vinSerial: fields.vin_serial,
      assetType: fields.asset_type,
      category: fields.category,
    },
    registry,
  );
  const existing = dups.map(toSimilar);

  // Same name (case/whitespace/punctuation only) or same VIN — never
  // overridable: the picker would render the two identically, and the database
  // refuses both anyway (`equipment_live_name_ci_key`, `equipment_live_vin_serial_key`).
  const myName = nameKey(fields.display_name);
  if (dups.some((d) => d.reason === 'same_name' || nameKey(d.row.displayName) === myName)) {
    return { ok: false, reason: 'name_taken', existing };
  }
  if (dups.some((d) => d.reason === 'same_vin')) {
    return { ok: false, reason: 'vin_taken', existing };
  }

  let override: {
    reason: string;
    distinct_from: { id: string; display_name: string; matched_on: MatchReason }[];
  } | null = null;
  if (dups.length > 0) {
    const confirm = input.confirm_distinct;
    if (!confirm) return { ok: false, reason: 'probable_duplicate', existing };
    const reason = confirm.reason.trim();
    if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
      return { ok: false, reason: 'override_reason_required', existing };
    }
    const acknowledged = new Set(confirm.distinct_from_ids);
    if (!dups.every((d) => acknowledged.has(d.row.id))) {
      // A match the person was never shown (the registry changed under them, or
      // a client skipped the list) cannot have been judged distinct.
      return { ok: false, reason: 'override_incomplete', existing };
    }
    override = {
      reason,
      distinct_from: dups.map((d) => ({
        id: d.row.id,
        display_name: d.row.displayName,
        matched_on: d.reason,
      })),
    };
  }

  const row = await tx.equipment.create({
    data: {
      site_id: input.site_id,
      display_name: fields.display_name,
      category: fields.category,
      is_active: input.is_active ?? true,
      unit_number: fields.unit_number,
      make: fields.make,
      asset_type: fields.asset_type,
      vin_serial: fields.vin_serial,
    },
  });
  await tx.auditLog.create({
    data: {
      actor_user_id: actor.actorUserId,
      action: 'insert' satisfies AuditAction,
      table_name: 'equipment',
      row_id: row.id,
      before: Prisma.JsonNull,
      after: {
        ...(serializeForAudit(row) as Record<string, unknown>),
        // ADR-0135 C — the override IS the audit fact: who said "this really is a
        // different asset", why, and which rows they said it about. Null when the
        // gate found nothing to override.
        duplicate_override: override,
      } as Prisma.InputJsonValue,
      ip: actor.ip,
      user_agent: actor.userAgent,
    },
  });
  if (override) {
    // The queue must not propose again what a person just judged distinct.
    await tx.equipmentDistinctPair.createMany({
      data: override.distinct_from.map((d) => ({
        ...orderedPair(row.id, d.id),
        reason: `create override: ${override.reason}`,
        decided_by: actor.actorUserId,
      })),
      skipDuplicates: true,
    });
  }
  return { ok: true, row };
}

/** `equipment_distinct_pairs` stores each pair once, smaller id first (CHECK in DDL). */
export function orderedPair(
  x: string,
  y: string,
): { equipment_a_id: string; equipment_b_id: string } {
  return x < y
    ? { equipment_a_id: x, equipment_b_id: y }
    : { equipment_a_id: y, equipment_b_id: x };
}

// ────────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────────

export interface UpdateEquipmentInput {
  display_name?: string | undefined;
  category?: EquipmentCategory | undefined;
  /** A `sites.id`, or null to make the asset FLEET-WIDE (ADR-0135). */
  site_id?: string | null | undefined;
  /** ADR-0135 D — correct the structured identity. Empty string clears. */
  unit_number?: string | undefined;
  make?: string | undefined;
  vin_serial?: string | undefined;
}

export type UpdateEquipmentResult =
  | { ok: true; equipment: AdminEquipmentDto }
  | { ok: false; reason: UpdateFailure };

type UpdateFailure =
  | 'not_found'
  | 'name_required'
  | 'name_too_long'
  | 'name_taken'
  | 'site_not_found'
  | 'unit_number_invalid'
  | 'field_too_long';

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
  actor: AnyActorContext,
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
    if (input.site_id !== null) {
      const site = await prisma.site.findUnique({
        where: { id: input.site_id },
        select: { id: true },
      });
      if (!site) return { ok: false, reason: 'site_not_found' };
    }
    nextSiteId = input.site_id;
    data.site_id = nextSiteId;
  }

  for (const [key, max] of [
    ['unit_number', UNIT_NUMBER_MAX],
    ['make', MAKE_MAX],
    ['vin_serial', VIN_SERIAL_MAX],
  ] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    let next: string | null = tidy(raw) || null;
    if (next && key === 'vin_serial') next = next.toUpperCase();
    if (next && key === 'unit_number') {
      next = next.replace(/^#\s*/, '');
      if (unitKey(next) === '' || /[,;/&\s]/.test(next))
        return { ok: false, reason: 'unit_number_invalid' };
    }
    if (next && next.length > max) return { ok: false, reason: 'field_too_long' };
    if (next !== existing[key]) data[key] = next;
  }

  if (input.category !== undefined && input.category !== existing.category) {
    data.category = input.category;
  }

  // Friendly pre-check for the two name uniques: exact `(site_id, display_name)`
  // (ADR-0063) and the ADR-0135 fleet-wide case/whitespace-insensitive live
  // name. The indexes are the guarantee; the P2002 catch below closes the race.
  if (nextName !== existing.display_name || nextSiteId !== existing.site_id) {
    const dup = await prisma.equipment.findFirst({
      where: {
        id: { not: id },
        OR: [
          { site_id: nextSiteId, display_name: nextName },
          // A merged loser is outside the live-name index, so only a live row
          // is held to it.
          ...(existing.merged_into_id
            ? []
            : [
                {
                  merged_into_id: null,
                  display_name: { equals: nextName, mode: 'insensitive' as const },
                },
              ]),
        ],
      },
      select: { id: true },
    });
    if (dup) return { ok: false, reason: 'name_taken' };
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.equipment.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          ...actorAuditFields(actor),
          action: 'update' satisfies AuditAction,
          table_name: 'equipment',
          row_id: id,
          before: serializeForAudit(existing),
          after: serializeForAudit(row),
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
// Merge (ADR-0075 D4, ADR-0135 F) — collapse duplicates onto one survivor.
//
// WHAT A MERGE MOVES: attribution, and ONLY attribution. EVERY foreign key into
// `equipment` is enumerated in {@link MERGE_REPOINTED_REFERENCES} /
// {@link MERGE_EXEMPT_REFERENCES}, and `admin-equipment.db.test.ts` asserts that
// list equals the live `pg_constraint` set — so a table added tomorrow with an
// FK to `equipment` fails CI until someone decides what a merge does with it.
// That is the class of the latent defect ADR-0135 §2 found: ADR-0079's
// `equipment_daily_throughput` and ADR-0088's `equipment_throughput_gap_alerts`
// arrived after ADR-0075 and were silently left on the loser.
//
// WHAT A MERGE MUST NEVER TOUCH: `ap_requests`. Not `status`, not the amounts,
// not `decided_by` / `decided_at`. The money already moved; a bookkeeping
// correction to WHICH machine an invoice names cannot reach back into the
// decision. The merge test asserts the `apRequest` writers are never called.
//
// `equipment_events` is out of the blast radius by construction: a Terex LOG
// keyed on a free-text `equipment_code` with no FK (ADR-0048 D3). `audit_log`
// rows naming the loser are history and are never rewritten (hard rule #6).
//
// The loser is KEPT — deactivated and stamped, never deleted.
// ────────────────────────────────────────────────────────────────────

/** Every `table.column` FK into `equipment` that a merge REPOINTS at the survivor. */
export const MERGE_REPOINTED_REFERENCES = [
  'ap_equipment_links.equipment_id',
  'ap_equipment_requests.resolved_equipment_id',
  'equipment_daily_throughput.equipment_id',
  'equipment_throughput_gap_alerts.equipment_id',
  // Rows previously merged INTO the loser follow it to the survivor, so
  // `merged_into_id` never becomes a chain (the seed guard walks one hop).
  'equipment.merged_into_id',
] as const;

/**
 * FKs into `equipment` a merge deliberately does NOT repoint, each with why.
 * `equipment_distinct_pairs`: a "these two are different" verdict is about the
 * two rows a person compared; once one is merged away it is not live, the queue
 * ignores it, and whether the SURVIVOR differs from the other row is a new
 * question for a person (ADR-0135 F).
 */
export const MERGE_EXEMPT_REFERENCES = [
  'equipment_distinct_pairs.equipment_a_id',
  'equipment_distinct_pairs.equipment_b_id',
] as const;

export type MergeFailure =
  | 'not_found'
  | 'same_row'
  /** Different yards and the caller did not say where the survivor lives. */
  | 'cross_site'
  | 'winner_merged'
  | 'loser_merged'
  | 'site_not_found'
  /** Both machines logged throughput on the same day — a person must pick which reading stands. */
  | 'throughput_conflict';

export interface MergeOptions {
  /**
   * ADR-0135 — where the survivor lives afterwards: a `sites.id`, or null for
   * FLEET-WIDE. REQUIRED when the two rows sit at different yards (a trailer seen
   * at both is the ordinary case, Bill 2026-09-23); optional otherwise, and
   * defaults to the winner's current site. A change is audited on the winner.
   */
  survivorSiteId?: string | null | undefined;
}

export interface MergeRepointCounts {
  links: number;
  requests: number;
  throughput: number;
  gapAlerts: number;
  mergedChildren: number;
}

export type MergeEquipmentResult =
  | {
      ok: true;
      winner: AdminEquipmentDto;
      /** `ap_equipment_links` rows repointed at the winner. */
      repointedLinks: number;
      /** `ap_equipment_requests.resolved_equipment_id` values repointed. */
      repointedRequests: number;
      /** Every table's count, including throughput + gap alerts (ADR-0135 F). */
      repointed: MergeRepointCounts;
    }
  | { ok: false; reason: MergeFailure; conflictDates?: string[] };

/**
 * Merge `loserId` into `winnerId`: repoint EVERY referencing table, deactivate
 * and stamp the loser, and audit — ONE transaction.
 *
 * ADR-0135 lifted ADR-0075's cross-site refusal: the same trailer is seeded at
 * one yard and re-created at the other (281577 / 282876 / 284460). A cross-site
 * merge now requires the caller to NAME the survivor's site (a yard, or null =
 * fleet-wide); it is never guessed. Still refused: same row, either side already
 * merged (no chains), and a throughput day recorded on BOTH machines — the
 * `(equipment_id, throughput_date)` live unique would refuse the repoint, and
 * which of two readings is true is a person's call, not a merge's.
 *
 * Every guard re-reads its row INSIDE the transaction, so two admins merging A→B
 * and B→A concurrently cannot leave a cycle.
 */
export async function mergeEquipment(
  winnerId: string,
  loserId: string,
  actor: AnyActorContext,
  opts: MergeOptions = {},
): Promise<MergeEquipmentResult> {
  if (winnerId === loserId) return { ok: false, reason: 'same_row' };

  const outcome = await prisma.$transaction(async (tx) => {
    const [winner, loser] = await Promise.all([
      tx.equipment.findUnique({ where: { id: winnerId } }),
      tx.equipment.findUnique({ where: { id: loserId } }),
    ]);
    if (!winner || !loser) return { ok: false, reason: 'not_found' } as const;
    if (winner.merged_into_id) return { ok: false, reason: 'winner_merged' } as const;
    if (loser.merged_into_id) return { ok: false, reason: 'loser_merged' } as const;

    const crossSite = winner.site_id !== loser.site_id;
    if (crossSite && opts.survivorSiteId === undefined) {
      return { ok: false, reason: 'cross_site' } as const;
    }
    const survivorSiteId = opts.survivorSiteId === undefined ? winner.site_id : opts.survivorSiteId;
    if (survivorSiteId !== null && survivorSiteId !== winner.site_id) {
      const site = await tx.site.findUnique({
        where: { id: survivorSiteId },
        select: { id: true },
      });
      if (!site) return { ok: false, reason: 'site_not_found' } as const;
    }

    // Throughput days recorded on BOTH machines cannot both survive on one.
    const [winnerDays, loserDays] = await Promise.all([
      tx.equipmentDailyThroughput.findMany({
        where: { equipment_id: winnerId, voided_at: null },
        select: { throughput_date: true },
      }),
      tx.equipmentDailyThroughput.findMany({
        where: { equipment_id: loserId, voided_at: null },
        select: { throughput_date: true },
      }),
    ]);
    const winnerDaySet = new Set(
      winnerDays.map((d) => d.throughput_date.toISOString().slice(0, 10)),
    );
    const conflictDates = loserDays
      .map((d) => d.throughput_date.toISOString().slice(0, 10))
      .filter((d) => winnerDaySet.has(d));
    if (conflictDates.length > 0) {
      return { ok: false, reason: 'throughput_conflict', conflictDates } as const;
    }

    const links = await tx.apEquipmentLink.updateMany({
      where: { equipment_id: loserId },
      data: { equipment_id: winnerId },
    });
    const requests = await tx.apEquipmentRequest.updateMany({
      where: { resolved_equipment_id: loserId },
      data: { resolved_equipment_id: winnerId },
    });
    const throughput = await tx.equipmentDailyThroughput.updateMany({
      where: { equipment_id: loserId },
      data: { equipment_id: winnerId },
    });
    const gapAlerts = await tx.equipmentThroughputGapAlert.updateMany({
      where: { equipment_id: loserId },
      data: { equipment_id: winnerId },
    });
    const mergedChildren = await tx.equipment.updateMany({
      where: { merged_into_id: loserId },
      data: { merged_into_id: winnerId },
    });

    const stamped = await tx.equipment.update({
      where: { id: loserId },
      data: {
        is_active: false,
        merged_into_id: winnerId,
        merged_by: actorUserIdOrNull(actor),
        merged_at: new Date(),
      },
    });

    // The survivor moves yard (or becomes fleet-wide) — its own audited fact.
    let winnerRow = winner;
    if (survivorSiteId !== winner.site_id) {
      winnerRow = await tx.equipment.update({
        where: { id: winnerId },
        data: { site_id: survivorSiteId },
      });
      await tx.auditLog.create({
        data: {
          ...actorAuditFields(actor),
          action: 'update' satisfies AuditAction,
          table_name: 'equipment',
          row_id: winnerId,
          before: serializeForAudit(winner),
          after: {
            ...(serializeForAudit(winnerRow) as Record<string, unknown>),
            via: 'merge_survivor_site',
            merged_from_id: loserId,
          } as Prisma.InputJsonValue,
        },
      });
    }

    const repointed: MergeRepointCounts = {
      links: links.count,
      requests: requests.count,
      throughput: throughput.count,
      gapAlerts: gapAlerts.count,
      mergedChildren: mergedChildren.count,
    };

    // Audit INSIDE the transaction (hard rule #6), filed against the LOSER — the
    // row whose state changed. Every repoint count rides in `after`, so the audit
    // alone answers "what moved".
    await tx.auditLog.create({
      data: {
        ...actorAuditFields(actor),
        action: 'update' satisfies AuditAction,
        table_name: 'equipment',
        row_id: loserId,
        before: serializeForAudit(loser),
        after: {
          ...(serializeForAudit(stamped) as Record<string, unknown>),
          merged_into_display_name: winner.display_name,
          cross_site: crossSite,
          survivor_site_id: survivorSiteId,
          repointed_links: links.count,
          repointed_equipment_requests: requests.count,
          repointed_daily_throughput: throughput.count,
          repointed_gap_alerts: gapAlerts.count,
          repointed_merged_children: mergedChildren.count,
        } as Prisma.InputJsonValue,
      },
    });

    return { ok: true, winnerRow, repointed } as const;
  });

  if (!outcome.ok) return outcome;

  const [codes, counts] = await Promise.all([siteCodeById(), linkCounts([winnerId])]);
  return {
    ok: true,
    winner: toDto(outcome.winnerRow, codes, counts.get(winnerId) ?? 0),
    repointedLinks: outcome.repointed.links,
    repointedRequests: outcome.repointed.requests,
    repointed: outcome.repointed,
  };
}

/**
 * How many rows would move if this asset were merged away — the numbers the
 * admin sees BEFORE confirming, for each side. Reads only.
 */
export async function equipmentReferenceCounts(
  id: string,
): Promise<{ links: number; requests: number; throughput: number; gapAlerts: number }> {
  const [links, requests, throughput, gapAlerts] = await Promise.all([
    prisma.apEquipmentLink.count({ where: { equipment_id: id } }),
    prisma.apEquipmentRequest.count({ where: { resolved_equipment_id: id } }),
    prisma.equipmentDailyThroughput.count({ where: { equipment_id: id } }),
    prisma.equipmentThroughputGapAlert.count({ where: { equipment_id: id } }),
  ]);
  return { links, requests, throughput, gapAlerts };
}

// ────────────────────────────────────────────────────────────────────
// Possible duplicates queue (ADR-0135 F / Phase 3)
// ────────────────────────────────────────────────────────────────────

export interface DuplicatePair {
  a: SimilarEquipment & { links: number };
  b: SimilarEquipment & { links: number };
  reason: MatchReason;
  crossSite: boolean;
}

/**
 * Every pair of LIVE rows the matcher calls a probable duplicate, minus the
 * pairs a person already judged distinct. Cross-site pairs are included — they
 * are the reason this queue exists (ADR-0135 §6).
 *
 * The matcher proposes; the admin disposes, per pair: Merge (choosing the
 * survivor and its site) or "Different assets" (recorded, with a reason).
 */
export async function listPossibleDuplicates(client: Client = prisma): Promise<DuplicatePair[]> {
  const [registry, verdicts] = await Promise.all([
    loadRegistry(client),
    client.equipmentDistinctPair.findMany({
      select: { equipment_a_id: true, equipment_b_id: true },
    }),
  ]);
  const judged = new Set(verdicts.map((v) => `${v.equipment_a_id}|${v.equipment_b_id}`));
  const live = registry.filter((r) => !r.mergedIntoId);

  const seen = new Set<string>();
  const pairs: { x: RegistryRow; y: RegistryRow; reason: MatchReason }[] = [];
  for (const x of live) {
    const others = live.filter((r) => r.id !== x.id);
    const hits = probableDuplicates(
      {
        text: x.displayName,
        unitNumber: x.unitNumber,
        vinSerial: x.vinSerial,
        assetType: x.assetType,
        category: x.category,
      },
      others,
    );
    for (const h of hits) {
      const { equipment_a_id, equipment_b_id } = orderedPair(x.id, h.row.id);
      const k = `${equipment_a_id}|${equipment_b_id}`;
      if (seen.has(k) || judged.has(k)) continue;
      seen.add(k);
      pairs.push({ x, y: h.row, reason: h.reason });
    }
  }

  const counts = await (async () => {
    const ids = [...new Set(pairs.flatMap((p) => [p.x.id, p.y.id]))];
    if (ids.length === 0) return new Map<string, number>();
    const grouped = await client.apEquipmentLink.groupBy({
      by: ['equipment_id'],
      where: { equipment_id: { in: ids } },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.equipment_id ?? '', g._count._all]));
  })();

  const side = (r: RegistryRow, reason: MatchReason) => ({
    ...toSimilar({ row: r, reason, probableDuplicate: true }),
    links: counts.get(r.id) ?? 0,
  });
  return pairs
    .map((p) => ({
      a: side(p.x, p.reason),
      b: side(p.y, p.reason),
      reason: p.reason,
      crossSite: p.x.siteId !== p.y.siteId,
    }))
    .sort(
      (p, q) =>
        Number(q.crossSite) - Number(p.crossSite) || p.a.displayName.localeCompare(q.a.displayName),
    );
}

export type MarkDistinctResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'same_row' | 'reason_required' };

/** Record "these two look alike but are different assets" — audited, never deleted. */
export async function markEquipmentDistinct(
  xId: string,
  yId: string,
  reason: string,
  actor: AnyActorContext,
): Promise<MarkDistinctResult> {
  if (xId === yId) return { ok: false, reason: 'same_row' };
  const why = reason.trim();
  if (why.length < OVERRIDE_REASON_MIN || why.length > OVERRIDE_REASON_MAX) {
    return { ok: false, reason: 'reason_required' };
  }
  return prisma.$transaction(async (tx) => {
    const found = await tx.equipment.count({ where: { id: { in: [xId, yId] } } });
    if (found !== 2) return { ok: false, reason: 'not_found' } as const;
    const pair = orderedPair(xId, yId);
    const row = await tx.equipmentDistinctPair.upsert({
      where: { equipment_a_id_equipment_b_id: pair },
      create: {
        ...pair,
        reason: why,
        decided_by: actorUserIdOrNull(actor),
        decided_label: isSystemActor(actor) ? actor.actorLabel : null,
      },
      update: {},
    });
    await tx.auditLog.create({
      data: {
        ...actorAuditFields(actor),
        action: 'insert' satisfies AuditAction,
        table_name: 'equipment_distinct_pairs',
        row_id: row.id,
        before: Prisma.JsonNull,
        after: { ...pair, reason: why } as Prisma.InputJsonValue,
      },
    });
    return { ok: true } as const;
  });
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
