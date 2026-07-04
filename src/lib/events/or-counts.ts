// ADR-0041 D3 — Oregon satellite collection-site unit counts (hand-entered
// monthly). The OR program bills these at $2.25/unit — that rate stays in
// `state_program_rules` (already seeded) and the INVOICE MATH is NOT done here;
// the sibling invoice engine consumes these rows at merge. This service is pure
// capture: create / list / update-before-lock, jurisdiction-gated to OR sites.
//
// Jurisdiction gate: these counts are an Oregon-only artifact (Eugene). A create
// against a California site is refused with a typed error rather than silently
// storing a CA row that would never bill — CA collection is captured as
// `collection_events`, not per-site monthly counts.

import { type RecordSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  RecordValidationError,
  RecordNotFoundError,
  assertUnlocked,
} from '@/lib/loads/record-guards';

const TABLE = 'or_collection_site_counts';

/** The count belongs to a non-Oregon site — refused (OR-only artifact). */
export class JurisdictionNotAllowedError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly siteId: string,
    readonly jurisdiction: string,
  ) {
    super(
      `or_collection_site_counts is an Oregon-only artifact; site ${siteId} is ${jurisdiction} — capture CA collection as collection_events instead`,
    );
    this.name = 'JurisdictionNotAllowedError';
  }
}

function billingMonthUTC(date: Date): Date {
  // First-of-month anchor at UTC midnight.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function assertUnits(units: number): void {
  if (!Number.isInteger(units) || units < 0 || units > 1_000_000) {
    throw new RecordValidationError(
      `units must be a whole number in [0, 1000000] (got ${String(units)})`,
    );
  }
}

async function assertOregonSite(siteId: string): Promise<void> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { jurisdiction: true },
  });
  if (!site) throw new RecordNotFoundError('sites', siteId);
  if (site.jurisdiction !== 'oregon')
    throw new JurisdictionNotAllowedError(siteId, site.jurisdiction);
}

export interface OrCountView {
  id: string;
  siteId: string;
  billingMonth: Date;
  location: string;
  units: number;
  source: RecordSource;
  lockedAt: Date | null;
}

function toView(r: {
  id: string;
  site_id: string;
  billing_month: Date;
  location: string;
  units: number;
  source: RecordSource;
  locked_at: Date | null;
}): OrCountView {
  return {
    id: r.id,
    siteId: r.site_id,
    billingMonth: r.billing_month,
    location: r.location,
    units: r.units,
    source: r.source,
    lockedAt: r.locked_at,
  };
}

export async function createOrCount(args: {
  siteId: string;
  billingMonth: Date;
  location: string;
  units: number;
  actorUserId: string;
}): Promise<OrCountView> {
  await assertOregonSite(args.siteId);
  if (!args.location.trim()) throw new RecordValidationError('location is required');
  assertUnits(args.units);
  const month = billingMonthUTC(args.billingMonth);

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.orCollectionSiteCount.create({
      data: {
        site_id: args.siteId,
        billing_month: month,
        location: args.location.trim(),
        units: args.units,
        source: 'manual',
        created_by: args.actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: TABLE,
        row_id: created.id,
        after: {
          billing_month: month.toISOString().slice(0, 10),
          location: created.location,
          units: created.units,
        },
      },
    });
    return created;
  });
  return toView(row);
}

export async function updateOrCount(args: {
  id: string;
  siteId: string;
  location?: string | undefined;
  units?: number | undefined;
  actorUserId: string;
}): Promise<OrCountView> {
  const existing = await prisma.orCollectionSiteCount.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  assertUnlocked(TABLE, args.id, existing.locked_at);
  if (args.location !== undefined && !args.location.trim())
    throw new RecordValidationError('location cannot be blank');
  if (args.units !== undefined) assertUnits(args.units);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.orCollectionSiteCount.update({
      where: { id: args.id },
      data: {
        ...(args.location !== undefined ? { location: args.location.trim() } : {}),
        ...(args.units !== undefined ? { units: args.units } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: { location: existing.location, units: existing.units },
        after: { location: updated.location, units: updated.units },
      },
    });
    return updated;
  });
  return toView(row);
}

export async function listOrCounts(siteId: string, limit = 100): Promise<OrCountView[]> {
  const rows = await prisma.orCollectionSiteCount.findMany({
    where: { site_id: siteId },
    orderBy: { billing_month: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}
