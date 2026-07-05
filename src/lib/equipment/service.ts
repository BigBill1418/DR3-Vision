// ADR-0044 D1 — equipment_events manager service (CRUD-lite, audited).
//
// The Terex-first equipment log: downtime, maintenance, repair, cost, and free
// notes. Site-scoped (CLAUDE.md hard rule #2); every write emits an `audit_log`
// row (hard rule #6 — append-only, never deleted). Events are FREELY EDITABLE
// (there is no `locked_at`) — the audit trail, not a lock, is the integrity
// mechanism. There is NO hard delete: removal is a soft-void (`voided_at`), which
// is itself audited and excludes the row from every derived series and the tile.
//
// `equipment_code` is a plain string (default 'terex'); a second machine is a data
// value, never a migration (D1). Throughput is NOT captured here — it is derived
// from `processed_units_daily` in `./throughput` (D2, one source of truth).

import { Prisma, type EquipmentEventKind, type RecordSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RecordValidationError, RecordNotFoundError } from '@/lib/loads/record-guards';

const TABLE = 'equipment_events';

/** Kinds for which `hours_down` is meaningful (an operational interruption). */
const DOWNTIME_KINDS: ReadonlySet<EquipmentEventKind> = new Set<EquipmentEventKind>([
  'downtime',
  'maintenance',
  'repair',
]);

/** Decimal(5,2) upper bound — hours in a single event can never exceed this. */
const MAX_HOURS_DOWN = 999.99;

function eventDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Enforce the equipment-event shape (D1):
 *   - `hours_down` is meaningful ONLY for downtime/maintenance/repair. A `cost`
 *     or `note` row carrying hours_down is rejected (a cost has no downtime; a
 *     note is not an interruption). hours_down, when present, must be in
 *     [0, 999.99] (Decimal(5,2)).
 *   - `cost_cents`, when present, must be a whole number >= 0.
 * Pure; returns the normalized values to persist (undefined inputs pass through
 * as "no change" for the update path — callers resolve those first).
 */
export function assertEquipmentShape(
  kind: EquipmentEventKind,
  hoursDown: number | null | undefined,
  costCents: number | null | undefined,
): { hoursDown: number | null; costCents: number | null } {
  const hours = hoursDown ?? null;
  const cents = costCents ?? null;

  if (hours != null) {
    if (!DOWNTIME_KINDS.has(kind)) {
      throw new RecordValidationError(
        `hours_down is only meaningful for downtime/maintenance/repair (got kind=${kind})`,
      );
    }
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > MAX_HOURS_DOWN) {
      throw new RecordValidationError(`hours_down must be a number in [0, ${MAX_HOURS_DOWN}] (got ${String(hours)})`);
    }
  }

  if (cents != null) {
    if (!Number.isInteger(cents) || cents < 0) {
      throw new RecordValidationError(`cost_cents must be a whole number of cents >= 0 (got ${String(cents)})`);
    }
  }

  return { hoursDown: hours, costCents: cents };
}

export interface EquipmentEventView {
  id: string;
  siteId: string;
  equipmentCode: string;
  eventDate: Date;
  kind: EquipmentEventKind;
  /** Hours the machine was down — decimal string, or null. */
  hoursDown: string | null;
  costCents: number | null;
  vendor: string | null;
  notes: string | null;
  source: string;
  createdBy: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

interface EquipmentRow {
  id: string;
  site_id: string;
  equipment_code: string;
  event_date: Date;
  kind: EquipmentEventKind;
  hours_down: Prisma.Decimal | null;
  cost_cents: number | null;
  vendor: string | null;
  notes: string | null;
  source: RecordSource;
  created_by: string | null;
  voided_at: Date | null;
  created_at: Date;
}

function toView(r: EquipmentRow): EquipmentEventView {
  return {
    id: r.id,
    siteId: r.site_id,
    equipmentCode: r.equipment_code,
    eventDate: r.event_date,
    kind: r.kind,
    hoursDown: r.hours_down?.toString() ?? null,
    costCents: r.cost_cents,
    vendor: r.vendor,
    notes: r.notes,
    source: r.source,
    createdBy: r.created_by,
    voidedAt: r.voided_at,
    createdAt: r.created_at,
  };
}

function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

export async function createEquipmentEvent(args: {
  siteId: string;
  eventDate: Date;
  kind: EquipmentEventKind;
  equipmentCode?: string | null;
  hoursDown?: number | null;
  costCents?: number | null;
  vendor?: string | null;
  notes?: string | null;
  actorUserId: string;
}): Promise<EquipmentEventView> {
  const shape = assertEquipmentShape(args.kind, args.hoursDown, args.costCents);
  const day = eventDateUTC(args.eventDate);
  const equipmentCode = clean(args.equipmentCode) ?? 'terex';

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.equipmentEvent.create({
      data: {
        site_id: args.siteId,
        equipment_code: equipmentCode,
        event_date: day,
        kind: args.kind,
        hours_down: shape.hoursDown,
        cost_cents: shape.costCents,
        vendor: clean(args.vendor),
        notes: clean(args.notes),
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
          equipment_code: equipmentCode,
          event_date: day.toISOString().slice(0, 10),
          kind: args.kind,
          hours_down: shape.hoursDown,
          cost_cents: shape.costCents,
        },
      },
    });
    return created;
  });
  return toView(row as EquipmentRow);
}

export async function updateEquipmentEvent(args: {
  id: string;
  siteId: string;
  // `| undefined` explicit (exactOptionalPropertyTypes; callers spread zod output).
  kind?: EquipmentEventKind | undefined;
  equipmentCode?: string | undefined;
  hoursDown?: number | null | undefined;
  costCents?: number | null | undefined;
  vendor?: string | null | undefined;
  notes?: string | null | undefined;
  actorUserId: string;
}): Promise<EquipmentEventView> {
  const existing = await prisma.equipmentEvent.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  if (existing.voided_at) {
    throw new RecordValidationError(`equipment event ${args.id} is voided and can no longer be edited`);
  }

  const kind = args.kind ?? existing.kind;
  const hoursDown = args.hoursDown !== undefined ? args.hoursDown : existing.hours_down?.toNumber() ?? null;
  const costCents = args.costCents !== undefined ? args.costCents : existing.cost_cents;
  const shape = assertEquipmentShape(kind, hoursDown, costCents);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.equipmentEvent.update({
      where: { id: args.id },
      data: {
        kind,
        hours_down: shape.hoursDown,
        cost_cents: shape.costCents,
        ...(args.equipmentCode !== undefined ? { equipment_code: clean(args.equipmentCode) ?? 'terex' } : {}),
        ...(args.vendor !== undefined ? { vendor: clean(args.vendor) } : {}),
        ...(args.notes !== undefined ? { notes: clean(args.notes) } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: {
          kind: existing.kind,
          hours_down: existing.hours_down?.toString() ?? null,
          cost_cents: existing.cost_cents,
        },
        after: { kind, hours_down: shape.hoursDown, cost_cents: shape.costCents },
      },
    });
    return updated;
  });
  return toView(row as EquipmentRow);
}

/**
 * Soft-void an event (no hard delete — hard rule #6 audit discipline). Sets
 * `voided_at`/`voided_by` and writes a `soft_delete` audit row. A voided event is
 * excluded from every derived series and the tile. Idempotency: re-voiding an
 * already-voided row is a no-op that does NOT write a second audit row.
 */
export async function voidEquipmentEvent(args: {
  id: string;
  siteId: string;
  actorUserId: string;
}): Promise<EquipmentEventView> {
  const existing = await prisma.equipmentEvent.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  if (existing.voided_at) return toView(existing as EquipmentRow);

  const row = await prisma.$transaction(async (tx) => {
    const voided = await tx.equipmentEvent.update({
      where: { id: args.id },
      data: { voided_at: new Date(), voided_by: args.actorUserId },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'soft_delete',
        table_name: TABLE,
        row_id: args.id,
        before: { voided_at: null },
        after: { voided_at: voided.voided_at?.toISOString() ?? null },
      },
    });
    return voided;
  });
  return toView(row as EquipmentRow);
}

/**
 * List events for a site, newest event-date first. Voided rows are excluded by
 * default (`includeVoided` surfaces them for an audit view).
 */
export async function listEquipmentEvents(
  siteId: string,
  opts: { limit?: number; includeVoided?: boolean; equipmentCode?: string } = {},
): Promise<EquipmentEventView[]> {
  const rows = await prisma.equipmentEvent.findMany({
    where: {
      site_id: siteId,
      ...(opts.includeVoided ? {} : { voided_at: null }),
      ...(opts.equipmentCode ? { equipment_code: opts.equipmentCode } : {}),
    },
    orderBy: [{ event_date: 'desc' }, { created_at: 'desc' }],
    take: opts.limit ?? 100,
  });
  return rows.map((r) => toView(r as EquipmentRow));
}
