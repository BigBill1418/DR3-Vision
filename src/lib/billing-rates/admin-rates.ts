// ADR-0040 D5/D7 — admin data layer for the four billing-rate tables.
//
// Every public write here:
//   - assumes the caller already passed `requireRateManager()` (route enforces the
//     gate; never trust the client),
//   - performs the mutation + an `audit_log` row in ONE Prisma transaction so an
//     audit row can never be lost on partial failure (CLAUDE.md hard rule #6), and
//   - emits a structured log line (actor, table, before→after) per ADR-0040 D7.
//
// Money is integer CENTS. Effective dates are `@db.Date` (UTC midnight). Dates cross
// the wire as `YYYY-MM-DD` strings and are normalized with `dateUTC` (mirrors the
// program-rules resolver's `ruleDateUTC`).

import { Prisma, type AuditAction } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import {
  assertValidTierSet,
  validateTierSet,
  type ProposedTier,
  type TierProblem,
} from './tier-validation';

export interface RateActor {
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

/** `YYYY-MM-DD` → UTC-midnight Date, matching `@db.Date` storage. Throws on garbage. */
export function dateUTC(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`invalid date '${iso}' (expected YYYY-MM-DD)`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date '${iso}'`);
  return d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function serialize(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

// One place that writes the audit row + the D7 structured log, inside a transaction.
async function writeAudit(
  tx: Prisma.TransactionClient,
  args: {
    action: AuditAction;
    table: string;
    rowId: string;
    before: unknown | null;
    after: unknown | null;
    actor: RateActor;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actor_user_id: args.actor.actorUserId,
      action: args.action,
      table_name: args.table,
      row_id: args.rowId,
      before: args.before == null ? Prisma.JsonNull : serialize(args.before),
      after: args.after == null ? Prisma.JsonNull : serialize(args.after),
      ip: args.actor.ip,
      user_agent: args.actor.userAgent,
    },
  });
  log.info(
    { actor: args.actor.actorUserId, table: args.table, row_id: args.rowId, action: args.action },
    '[rate-write] rate table mutated',
  );
}

// ════════════════════════════════════════════════════════════════════════
// D1 — transport_rate_tiers
// ════════════════════════════════════════════════════════════════════════

export type FreightJurisdiction = 'CA' | 'OR';

export interface TierDto {
  id: string;
  jurisdiction: FreightJurisdiction;
  min_miles: number;
  max_miles: number;
  rate_cents: number;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
  note: string | null;
}

export async function listTiers(jurisdiction?: FreightJurisdiction): Promise<TierDto[]> {
  const args: Prisma.TransportRateTierFindManyArgs = {
    orderBy: [{ jurisdiction: 'asc' }, { effective_from: 'desc' }, { min_miles: 'asc' }],
  };
  if (jurisdiction) args.where = { jurisdiction };
  const rows = await prisma.transportRateTier.findMany(args);
  return rows.map((r) => ({
    id: r.id,
    jurisdiction: r.jurisdiction,
    min_miles: r.min_miles,
    max_miles: r.max_miles,
    rate_cents: r.rate_cents,
    effective_from: isoDay(r.effective_from),
    effective_to: r.effective_to ? isoDay(r.effective_to) : null,
    note: r.note,
  }));
}

export interface SaveTierSetInput {
  jurisdiction: FreightJurisdiction;
  effective_from: string; // the window this set governs
  effective_to?: string | null;
  tiers: ProposedTier[];
  note?: string | null;
}

export type SaveTierSetResult =
  | { ok: true; tiers: TierDto[] }
  | { ok: false; reason: 'invalid_set'; problems: TierProblem[] };

/**
 * Replace the tier set for ONE (jurisdiction, effective_from) window. Validates the
 * WHOLE set (contiguous-from-0, non-overlapping, no gaps) before persisting — a
 * renegotiation is a NEW window (new `effective_from`), so older windows are never
 * touched (ADR-0040 D1: history is never edited). Writes one audit row capturing the
 * before→after set.
 */
export async function saveTierSet(
  input: SaveTierSetInput,
  actor: RateActor,
): Promise<SaveTierSetResult> {
  const problems = validateTierSet(input.tiers);
  if (problems.length > 0) return { ok: false, reason: 'invalid_set', problems };

  const from = dateUTC(input.effective_from);
  const to = input.effective_to ? dateUTC(input.effective_to) : null;

  const saved = await prisma.$transaction(async (tx) => {
    const before = await tx.transportRateTier.findMany({
      where: { jurisdiction: input.jurisdiction, effective_from: from },
      orderBy: { min_miles: 'asc' },
    });
    await tx.transportRateTier.deleteMany({
      where: { jurisdiction: input.jurisdiction, effective_from: from },
    });
    const created = [];
    for (const t of input.tiers) {
      created.push(
        await tx.transportRateTier.create({
          data: {
            jurisdiction: input.jurisdiction,
            min_miles: t.min_miles,
            max_miles: t.max_miles,
            rate_cents: t.rate_cents,
            effective_from: from,
            effective_to: to,
            note: input.note ?? null,
            created_by: actor.actorUserId,
          },
        }),
      );
    }
    await writeAudit(tx, {
      action: before.length === 0 ? 'insert' : 'update',
      table: 'transport_rate_tiers',
      rowId: `${input.jurisdiction}:${input.effective_from}`,
      before: before.length === 0 ? null : before,
      after: created,
      actor,
    });
    return created;
  });

  return {
    ok: true,
    tiers: saved.map((r) => ({
      id: r.id,
      jurisdiction: r.jurisdiction,
      min_miles: r.min_miles,
      max_miles: r.max_miles,
      rate_cents: r.rate_cents,
      effective_from: isoDay(r.effective_from),
      effective_to: r.effective_to ? isoDay(r.effective_to) : null,
      note: r.note,
    })),
  };
}

/** Pure re-export so the route/UI can pre-validate before POSTing. */
export { validateTierSet, assertValidTierSet };

// ════════════════════════════════════════════════════════════════════════
// D2 — account_haul_rates
// ════════════════════════════════════════════════════════════════════════

export interface HaulRateDto {
  id: string;
  source_id: string;
  rate_cents: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}

function haulDto(r: {
  id: string;
  source_id: string;
  rate_cents: number;
  effective_from: Date;
  effective_to: Date | null;
  note: string | null;
}): HaulRateDto {
  return {
    id: r.id,
    source_id: r.source_id,
    rate_cents: r.rate_cents,
    effective_from: isoDay(r.effective_from),
    effective_to: r.effective_to ? isoDay(r.effective_to) : null,
    note: r.note,
  };
}

export async function listHaulRates(sourceId?: string): Promise<HaulRateDto[]> {
  const args: Prisma.AccountHaulRateFindManyArgs = {
    orderBy: [{ source_id: 'asc' }, { effective_from: 'desc' }],
  };
  if (sourceId) args.where = { source_id: sourceId };
  const rows = await prisma.accountHaulRate.findMany(args);
  return rows.map(haulDto);
}

export interface HaulRateInput {
  source_id: string;
  rate_cents: number;
  effective_from: string;
  effective_to?: string | null;
  note?: string | null;
}

export type HaulRateResult =
  | { ok: true; rate: HaulRateDto }
  | { ok: false; reason: 'source_not_found' | 'not_found' | 'invalid_amount' };

export async function createHaulRate(input: HaulRateInput, actor: RateActor): Promise<HaulRateResult> {
  if (!Number.isInteger(input.rate_cents) || input.rate_cents <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const source = await prisma.source.findUnique({ where: { id: input.source_id }, select: { id: true } });
  if (!source) return { ok: false, reason: 'source_not_found' };

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.accountHaulRate.create({
      data: {
        source_id: input.source_id,
        rate_cents: input.rate_cents,
        effective_from: dateUTC(input.effective_from),
        effective_to: input.effective_to ? dateUTC(input.effective_to) : null,
        note: input.note ?? null,
        created_by: actor.actorUserId,
      },
    });
    await writeAudit(tx, {
      action: 'insert',
      table: 'account_haul_rates',
      rowId: created.id,
      before: null,
      after: created,
      actor,
    });
    return created;
  });
  return { ok: true, rate: haulDto(row) };
}

export interface HaulRateUpdate {
  rate_cents?: number;
  effective_from?: string;
  effective_to?: string | null;
  note?: string | null;
}

export async function updateHaulRate(
  id: string,
  input: HaulRateUpdate,
  actor: RateActor,
): Promise<HaulRateResult> {
  if (input.rate_cents !== undefined && (!Number.isInteger(input.rate_cents) || input.rate_cents <= 0)) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const existing = await prisma.accountHaulRate.findUnique({ where: { id } });
  if (!existing) return { ok: false, reason: 'not_found' };

  const data: Prisma.AccountHaulRateUpdateInput = {};
  if (input.rate_cents !== undefined) data.rate_cents = input.rate_cents;
  if (input.effective_from !== undefined) data.effective_from = dateUTC(input.effective_from);
  if (input.effective_to !== undefined) data.effective_to = input.effective_to ? dateUTC(input.effective_to) : null;
  if (input.note !== undefined) data.note = input.note;

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.accountHaulRate.update({ where: { id }, data });
    await writeAudit(tx, {
      action: 'update',
      table: 'account_haul_rates',
      rowId: id,
      before: existing,
      after: updated,
      actor,
    });
    return updated;
  });
  return { ok: true, rate: haulDto(row) };
}

// ════════════════════════════════════════════════════════════════════════
// D3 — container_rental_sites
// ════════════════════════════════════════════════════════════════════════

export interface RentalDto {
  id: string;
  site_id: string;
  location_name: string;
  source_id: string | null;
  trailer_count: number;
  trailer_size: string | null;
  monthly_rate_cents: number;
  active: boolean;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}

function rentalDto(r: {
  id: string;
  site_id: string;
  location_name: string;
  source_id: string | null;
  trailer_count: number;
  trailer_size: string | null;
  monthly_rate_cents: number;
  active: boolean;
  effective_from: Date;
  effective_to: Date | null;
  note: string | null;
}): RentalDto {
  return {
    id: r.id,
    site_id: r.site_id,
    location_name: r.location_name,
    source_id: r.source_id,
    trailer_count: r.trailer_count,
    trailer_size: r.trailer_size,
    monthly_rate_cents: r.monthly_rate_cents,
    active: r.active,
    effective_from: isoDay(r.effective_from),
    effective_to: r.effective_to ? isoDay(r.effective_to) : null,
    note: r.note,
  };
}

export async function listRentals(siteId?: string): Promise<RentalDto[]> {
  const args: Prisma.ContainerRentalSiteFindManyArgs = {
    orderBy: [{ site_id: 'asc' }, { location_name: 'asc' }, { effective_from: 'desc' }],
  };
  if (siteId) args.where = { site_id: siteId };
  const rows = await prisma.containerRentalSite.findMany(args);
  return rows.map(rentalDto);
}

export interface RentalInput {
  site_id: string;
  location_name: string;
  source_id?: string | null;
  trailer_count: number;
  trailer_size?: string | null;
  monthly_rate_cents: number;
  active?: boolean;
  effective_from: string;
  effective_to?: string | null;
  note?: string | null;
}

export type RentalResult =
  | { ok: true; rental: RentalDto }
  | { ok: false; reason: 'site_not_found' | 'source_not_found' | 'not_found' | 'invalid_amount' };

export async function createRental(input: RentalInput, actor: RateActor): Promise<RentalResult> {
  if (!Number.isInteger(input.monthly_rate_cents) || input.monthly_rate_cents <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const site = await prisma.site.findUnique({ where: { id: input.site_id }, select: { id: true } });
  if (!site) return { ok: false, reason: 'site_not_found' };
  if (input.source_id) {
    const src = await prisma.source.findUnique({ where: { id: input.source_id }, select: { id: true } });
    if (!src) return { ok: false, reason: 'source_not_found' };
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.containerRentalSite.create({
      data: {
        site_id: input.site_id,
        location_name: input.location_name,
        source_id: input.source_id ?? null,
        trailer_count: input.trailer_count,
        trailer_size: input.trailer_size ?? null,
        monthly_rate_cents: input.monthly_rate_cents,
        active: input.active ?? true,
        effective_from: dateUTC(input.effective_from),
        effective_to: input.effective_to ? dateUTC(input.effective_to) : null,
        note: input.note ?? null,
        created_by: actor.actorUserId,
      },
    });
    await writeAudit(tx, {
      action: 'insert',
      table: 'container_rental_sites',
      rowId: created.id,
      before: null,
      after: created,
      actor,
    });
    return created;
  });
  return { ok: true, rental: rentalDto(row) };
}

export interface RentalUpdate {
  location_name?: string;
  source_id?: string | null;
  trailer_count?: number;
  trailer_size?: string | null;
  monthly_rate_cents?: number;
  active?: boolean;
  effective_from?: string;
  effective_to?: string | null;
  note?: string | null;
}

export async function updateRental(
  id: string,
  input: RentalUpdate,
  actor: RateActor,
): Promise<RentalResult> {
  if (
    input.monthly_rate_cents !== undefined &&
    (!Number.isInteger(input.monthly_rate_cents) || input.monthly_rate_cents <= 0)
  ) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const existing = await prisma.containerRentalSite.findUnique({ where: { id } });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (input.source_id) {
    const src = await prisma.source.findUnique({ where: { id: input.source_id }, select: { id: true } });
    if (!src) return { ok: false, reason: 'source_not_found' };
  }

  const data: Prisma.ContainerRentalSiteUpdateInput = {};
  if (input.location_name !== undefined) data.location_name = input.location_name;
  if (input.source_id !== undefined) data.source_id = input.source_id;
  if (input.trailer_count !== undefined) data.trailer_count = input.trailer_count;
  if (input.trailer_size !== undefined) data.trailer_size = input.trailer_size;
  if (input.monthly_rate_cents !== undefined) data.monthly_rate_cents = input.monthly_rate_cents;
  if (input.active !== undefined) data.active = input.active;
  if (input.effective_from !== undefined) data.effective_from = dateUTC(input.effective_from);
  if (input.effective_to !== undefined) data.effective_to = input.effective_to ? dateUTC(input.effective_to) : null;
  if (input.note !== undefined) data.note = input.note;

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.containerRentalSite.update({ where: { id }, data });
    await writeAudit(tx, {
      action: 'update',
      table: 'container_rental_sites',
      rowId: id,
      before: existing,
      after: updated,
      actor,
    });
    return updated;
  });
  return { ok: true, rental: rentalDto(row) };
}

// ════════════════════════════════════════════════════════════════════════
// D4 — fuel_prices (manual entry / audited overwrite)
// ════════════════════════════════════════════════════════════════════════

export interface FuelPriceDto {
  id: string;
  week_of: string;
  usd_per_gal: string; // Decimal preserved as a string (no float drift)
  source: 'eia_api' | 'manual';
  fetched_at: string; // ISO
  note: string | null;
}

function fuelDto(r: {
  id: string;
  week_of: Date;
  usd_per_gal: Prisma.Decimal;
  source: 'eia_api' | 'manual';
  fetched_at: Date;
  note: string | null;
}): FuelPriceDto {
  return {
    id: r.id,
    week_of: isoDay(r.week_of),
    usd_per_gal: r.usd_per_gal.toString(),
    source: r.source,
    fetched_at: r.fetched_at.toISOString(),
    note: r.note,
  };
}

export async function listFuelPrices(limit = 26): Promise<FuelPriceDto[]> {
  const rows = await prisma.fuelPrice.findMany({ orderBy: { week_of: 'desc' }, take: limit });
  return rows.map(fuelDto);
}

export interface FuelPriceInput {
  week_of: string; // any date in the week; normalized to the Monday
  usd_per_gal: number;
  note?: string | null;
}

export type FuelPriceResult =
  | { ok: true; price: FuelPriceDto }
  | { ok: false; reason: 'invalid_amount' };

/**
 * Manual fuel-price entry — creates OR overwrites the week's row with `source=manual`
 * (a manual entry wins over a later api fetch; the overwrite is audited). `week_of` is
 * normalized to the Monday of its week.
 */
export async function upsertManualFuelPrice(
  input: FuelPriceInput,
  actor: RateActor,
): Promise<FuelPriceResult> {
  if (!(input.usd_per_gal > 0) || input.usd_per_gal >= 100) {
    return { ok: false, reason: 'invalid_amount' };
  }
  // Monday-of-week (inlined to avoid importing the fuel resolver graph).
  const base = dateUTC(input.week_of);
  const offsetFromMonday = (base.getUTCDay() + 6) % 7;
  const weekOf = new Date(base);
  weekOf.setUTCDate(weekOf.getUTCDate() - offsetFromMonday);
  const now = new Date();

  const row = await prisma.$transaction(async (tx) => {
    const before = await tx.fuelPrice.findUnique({ where: { week_of: weekOf } });
    const saved = await tx.fuelPrice.upsert({
      where: { week_of: weekOf },
      create: {
        week_of: weekOf,
        usd_per_gal: new Prisma.Decimal(input.usd_per_gal),
        source: 'manual',
        fetched_at: now,
        note: input.note ?? null,
        created_by: actor.actorUserId,
      },
      update: {
        usd_per_gal: new Prisma.Decimal(input.usd_per_gal),
        source: 'manual',
        fetched_at: now,
        note: input.note ?? null,
      },
    });
    await writeAudit(tx, {
      action: before ? 'update' : 'insert',
      table: 'fuel_prices',
      rowId: saved.id,
      before: before ? { ...before, usd_per_gal: before.usd_per_gal.toString() } : null,
      after: { ...saved, usd_per_gal: saved.usd_per_gal.toString() },
      actor,
    });
    return saved;
  });
  return { ok: true, price: fuelDto(row) };
}
