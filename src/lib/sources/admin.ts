// ADR-0125 (Phase 0 gap G-3) — the collection-source classifiers get a surface.
//
// `sources.is_trans_charge`, `sources.is_non_program` and
// `sources.canonical_mileage` are three columns that decide MONEY, and until now
// all three were seed-only: there was no `/admin/sources` route anywhere in the
// page tree, no create/update call for `canonical_mileage` anywhere in `src/` or
// `scripts/` (DDL only), and the only way to classify a new non-program source
// was to edit the seed or run SQL by hand.
//
// What that cost, measured:
//
//  - `is_trans_charge` splits the workbook's two inbound tabs and gates the CA
//    freight leg. With no writer it stayed false everywhere and
//    `resolveTransportationInputs` selected an empty set in silence.
//  - `canonical_mileage` is the `miles` input to `computeFuelSurchargeCents`.
//    Never written, so the fuel-surcharge leg was uncomputable from birth.
//  - `is_non_program` decides which POOL a load's units land in — the pool MRC
//    is billed on. A misclassified source silently bills the wrong number.
//
// `haul_assignment` is new here (G-9): the workbook's `variables!Mileage_Table`
// carries an Assignment column that selects which haul-rate leg a source bills
// on, and it had no home at all. `woodland-freight.ts` pins every Woodland row
// to Primary and says in the source that it is a transitional hack.
//
// ADMIN POWER, not site reach (CLAUDE.md hard rule #2): these classifiers move
// billing, so the gate is `role === 'admin'`, never `all_sites`. Every write is
// audited with before/after (hard rule #6) on the same transaction.

import { Prisma, type SourceHaulAssignment } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RecordValidationError } from '@/lib/loads/record-guards';

const TABLE = 'sources';

export interface SourceClassificationView {
  id: string;
  siteId: string;
  siteCode: string;
  name: string;
  city: string | null;
  state: string | null;
  isActive: boolean;
  isNonProgram: boolean;
  isTransCharge: boolean;
  canonicalMileage: number | null;
  haulAssignment: SourceHaulAssignment | null;
}

/**
 * List classification rows. `siteId` narrows to one site; omitted lists every
 * site, which is legitimate here precisely because this is an admin-only
 * surface — the classifiers are maintained against a single workbook table that
 * spans both sites.
 */
export async function listSourceClassifications(args: {
  siteId?: string | undefined;
  search?: string | undefined;
  limit?: number;
}): Promise<SourceClassificationView[]> {
  const rows = await prisma.source.findMany({
    where: {
      ...(args.siteId ? { site_id: args.siteId } : {}),
      ...(args.search && args.search.trim() !== ''
        ? { name: { contains: args.search.trim(), mode: 'insensitive' as const } }
        : {}),
    },
    orderBy: [{ site_id: 'asc' }, { name: 'asc' }],
    take: Math.min(Math.max(args.limit ?? 200, 1), 500),
    select: {
      id: true,
      site_id: true,
      name: true,
      city: true,
      state: true,
      is_active: true,
      is_non_program: true,
      is_trans_charge: true,
      canonical_mileage: true,
      haul_assignment: true,
      site: { select: { code: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    siteCode: r.site.code,
    name: r.name,
    city: r.city,
    state: r.state,
    isActive: r.is_active,
    isNonProgram: r.is_non_program,
    isTransCharge: r.is_trans_charge,
    canonicalMileage: r.canonical_mileage,
    haulAssignment: r.haul_assignment,
  }));
}

const HAUL_ASSIGNMENTS: readonly SourceHaulAssignment[] = [
  'primary',
  'secondary',
  'tertiary',
] as const;

/**
 * Update one source's classifiers. Only the keys present are written, so an
 * editor that renders one column cannot blank the other three.
 *
 * The before/after audit payload carries ONLY the fields that actually changed.
 * A payload listing every column would make a one-flag edit and a four-flag edit
 * look the same in the trail, and this is the trail a billing dispute is read
 * from.
 */
export async function updateSourceClassification(args: {
  sourceId: string;
  isNonProgram?: boolean | undefined;
  isTransCharge?: boolean | undefined;
  canonicalMileage?: number | null | undefined;
  haulAssignment?: SourceHaulAssignment | null | undefined;
  actorUserId: string;
}): Promise<SourceClassificationView> {
  if (args.canonicalMileage != null) {
    if (
      !Number.isInteger(args.canonicalMileage) ||
      args.canonicalMileage < 0 ||
      args.canonicalMileage > 10_000
    ) {
      throw new RecordValidationError(
        `canonical_mileage must be a whole number of miles in [0, 10000] (got ${String(args.canonicalMileage)})`,
      );
    }
  }
  if (args.haulAssignment != null && !HAUL_ASSIGNMENTS.includes(args.haulAssignment)) {
    throw new RecordValidationError(
      `haul_assignment must be one of ${HAUL_ASSIGNMENTS.join(', ')}`,
    );
  }

  const existing = await prisma.source.findUnique({
    where: { id: args.sourceId },
    select: {
      id: true,
      is_non_program: true,
      is_trans_charge: true,
      canonical_mileage: true,
      haul_assignment: true,
    },
  });
  if (!existing) throw new RecordValidationError(`source ${args.sourceId} not found`);

  const data: Record<string, unknown> = {};
  // `Prisma.InputJsonValue`-shaped, not `unknown`: the audit payload is a JSON
  // column, and typing it loosely is how a Date or a Decimal ends up serialized
  // into a permanent record as `{}`.
  const before: Prisma.JsonObject = {};
  const after: Prisma.JsonObject = {};
  const put = (key: string, next: Prisma.JsonValue | undefined, prev: Prisma.JsonValue) => {
    if (next === undefined || next === prev) return;
    data[key] = next;
    before[key] = prev;
    after[key] = next;
  };
  put('is_non_program', args.isNonProgram, existing.is_non_program);
  put('is_trans_charge', args.isTransCharge, existing.is_trans_charge);
  put('canonical_mileage', args.canonicalMileage, existing.canonical_mileage);
  put('haul_assignment', args.haulAssignment, existing.haul_assignment);

  if (Object.keys(data).length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.source.update({ where: { id: args.sourceId }, data });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: TABLE,
          row_id: args.sourceId,
          before,
          after,
        },
      });
    });
  }

  const [row] = await listSourceClassificationsById(args.sourceId);
  if (!row) throw new RecordValidationError(`source ${args.sourceId} not found`);
  return row;
}

async function listSourceClassificationsById(id: string): Promise<SourceClassificationView[]> {
  const rows = await prisma.source.findMany({
    where: { id },
    select: {
      id: true,
      site_id: true,
      name: true,
      city: true,
      state: true,
      is_active: true,
      is_non_program: true,
      is_trans_charge: true,
      canonical_mileage: true,
      haul_assignment: true,
      site: { select: { code: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    siteCode: r.site.code,
    name: r.name,
    city: r.city,
    state: r.state,
    isActive: r.is_active,
    isNonProgram: r.is_non_program,
    isTransCharge: r.is_trans_charge,
    canonicalMileage: r.canonical_mileage,
    haulAssignment: r.haul_assignment,
  }));
}
