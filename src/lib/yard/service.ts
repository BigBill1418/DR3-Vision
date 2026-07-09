// handoff §1.8 — manager Yard view service (SCAFFOLD: list + add/edit, no workflow).
//
// Site-scoped (CLAUDE.md hard rule #2 — the route enforces reach via
// `requireManagerForSite`; this data layer trusts the resolved `siteId` and never
// widens it). Every write pairs the mutation with an append-only `audit_log` row in
// ONE Prisma transaction (hard rule #6 — an audit row can never be lost on a partial
// failure). `container_rental_sites` money is integer CENTS; the Yard view only READS
// those rows for rental context and NEVER writes them (rate edits are the ADR-0040
// admin surface). Typed errors mirror the loads/inventory record guards.

import type { Prisma, YardTrailerStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RecordNotFoundError, RecordValidationError } from '@/lib/loads/record-guards';
import { onHand as computeOnHand } from '@/lib/inventory/running-balance';

const TABLE = 'yard_trailers';

// ── DTOs ────────────────────────────────────────────────────────────────

/** A trailer/yard position, flattened for the manager surface. */
export interface YardTrailerView {
  id: string;
  siteId: string;
  label: string;
  locationNote: string | null;
  status: YardTrailerStatus;
}

function toView(r: {
  id: string;
  site_id: string;
  label: string;
  location_note: string | null;
  status: YardTrailerStatus;
}): YardTrailerView {
  return {
    id: r.id,
    siteId: r.site_id,
    label: r.label,
    locationNote: r.location_note,
    status: r.status,
  };
}

/** A rental container row (read-only context from `container_rental_sites`). */
export interface YardRentalView {
  id: string;
  locationName: string;
  trailerCount: number;
  trailerSize: string | null;
  monthlyRateCents: number;
  active: boolean;
}

/** The whole Yard read model: rental context + tracked trailers + on-hand total. */
export interface YardView {
  rentals: YardRentalView[];
  trailers: YardTrailerView[];
  /** Whole-units-on-hand total for the site, as a string (no float drift). */
  onHand: string;
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function listTrailers(siteId: string): Promise<YardTrailerView[]> {
  const rows = await prisma.yardTrailer.findMany({
    where: { site_id: siteId },
    orderBy: { label: 'asc' },
  });
  return rows.map(toView);
}

/**
 * The Yard read model for one site: all rental containers (ordered by location),
 * all tracked trailers (ordered by label), and the current whole-units-on-hand
 * total. On-hand comes from the ONE shared running-balance computation (D6) as of
 * now — the simplest correct source; the Yard view is display-only for it.
 */
export async function getYardView(siteId: string): Promise<YardView> {
  const [rentals, trailers, balance] = await Promise.all([
    prisma.containerRentalSite.findMany({
      where: { site_id: siteId },
      orderBy: { location_name: 'asc' },
    }),
    listTrailers(siteId),
    computeOnHand(siteId, new Date()),
  ]);
  return {
    rentals: rentals.map((r) => ({
      id: r.id,
      locationName: r.location_name,
      trailerCount: r.trailer_count,
      trailerSize: r.trailer_size,
      monthlyRateCents: r.monthly_rate_cents,
      active: r.active,
    })),
    trailers,
    onHand: balance.total.toString(),
  };
}

// ── Writes (audited, transactional) ──────────────────────────────────────

export async function createTrailer(args: {
  siteId: string;
  label: string;
  // `| undefined` explicit — the repo runs exactOptionalPropertyTypes and the route
  // spreads zod `.optional()` output into this shape.
  locationNote?: string | null | undefined;
  status?: YardTrailerStatus | undefined;
  actorUserId: string | null;
}): Promise<YardTrailerView> {
  const label = args.label.trim();
  if (!label) throw new RecordValidationError('label is required');
  const status: YardTrailerStatus = args.status ?? 'on_yard';

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.yardTrailer.create({
      data: {
        site_id: args.siteId,
        label,
        location_note: args.locationNote ?? null,
        status,
        created_by: args.actorUserId,
        updated_by: args.actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: TABLE,
        row_id: created.id,
        after: {
          site_id: created.site_id,
          label: created.label,
          location_note: created.location_note,
          status: created.status,
        },
      },
    });
    return created;
  });
  return toView(row);
}

export async function updateTrailer(args: {
  id: string;
  siteId: string;
  // `| undefined` explicit — the repo runs exactOptionalPropertyTypes and the route
  // spreads zod `.optional()` output into this shape.
  label?: string | undefined;
  locationNote?: string | null | undefined;
  status?: YardTrailerStatus | undefined;
  actorUserId: string | null;
}): Promise<YardTrailerView> {
  const existing = await prisma.yardTrailer.findUnique({ where: { id: args.id } });
  // 404 on a missing row OR a cross-site id — a manager must never learn that a row
  // exists at another site (hard rule #2).
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);

  const data: Prisma.YardTrailerUpdateInput = { updated_by: args.actorUserId };
  if (args.label !== undefined) {
    const label = args.label.trim();
    if (!label) throw new RecordValidationError('label is required');
    data.label = label;
  }
  if (args.locationNote !== undefined) data.location_note = args.locationNote;
  if (args.status !== undefined) data.status = args.status;

  // Snapshot the prior state BEFORE the mutation so the audit `before` is captured
  // independently of the updated row.
  const before = {
    label: existing.label,
    location_note: existing.location_note,
    status: existing.status,
  };

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.yardTrailer.update({ where: { id: args.id }, data });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before,
        after: {
          label: updated.label,
          location_note: updated.location_note,
          status: updated.status,
        },
      },
    });
    return updated;
  });
  return toView(row);
}
