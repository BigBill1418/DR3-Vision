// ADR-0045 D2 — equipment-events provider (graceful absent-table fallback).
//
// The board pack / weekly digest reports "notable equipment events" and "big
// cost bumps" that live in the ADR-0044 equipment module — a SIBLING build. In
// THIS worktree the `equipment_events` table and its Prisma model do not exist,
// so the digest composer must not reference `prisma.equipmentEvent`. Following
// the ADR-0039 leg-fetcher precedent (the comparators never touch a Prisma
// model — fetchers are INJECTED), equipment access is an injectable interface
// with a safe default that returns nothing.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ ADR-0045 MERGE-WIRING (for the human resolving the 0044/0045 merge):   │
// │ After ADR-0044's `equipment_events` model lands in schema.prisma,      │
// │ implement a `prismaEquipmentProvider(prisma)` that maps its rows onto  │
// │ `EquipmentEvent` below and pass it into `runUpdateDigestFire` /        │
// │ `generateBoardPackDraft` in place of `absentEquipmentProvider`. Until  │
// │ then the digest simply omits the equipment section (documented in the  │
// │ generated draft body), never crashes, and is a one-line swap at merge. │
// └──────────────────────────────────────────────────────────────────────┘

export interface EquipmentEvent {
  id: string;
  siteId: string | null;
  occurredAt: Date;
  kind: string;
  label: string;
  /** Integer cents; present for cost events, null otherwise. */
  costCents: number | null;
}

export interface EquipmentProvider {
  /** Notable events in [startISO, endISO] (inclusive @db.Date bounds). */
  notableEvents(siteId: string, startISO: string, endISO: string): Promise<EquipmentEvent[]>;
  /** Cost events at or above `thresholdCents` in [startISO, endISO]. */
  bigCostEvents(
    siteId: string,
    startISO: string,
    endISO: string,
    thresholdCents: number,
  ): Promise<EquipmentEvent[]>;
  /** False when the underlying table is absent (this worktree) — drives copy. */
  readonly available: boolean;
}

/**
 * The default provider used until the ADR-0044 equipment table is wired at
 * merge. Returns nothing and reports `available: false` so the composer can
 * print an honest "equipment events unavailable" line instead of a blank.
 */
export const absentEquipmentProvider: EquipmentProvider = {
  available: false,
  async notableEvents() {
    return [];
  },
  async bigCostEvents() {
    return [];
  },
};

/**
 * Live provider over ADR-0044's `equipment_events` (wired at the 0044/0045
 * merge per the MERGE-WIRING block above). Voided rows excluded; `label`
 * composes kind + equipment_code + a note snippet for digest copy.
 */
export function prismaEquipmentProvider(prisma: import('@prisma/client').PrismaClient): EquipmentProvider {
  const dayKey = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const toEvent = (r: {
    id: string;
    site_id: string;
    equipment_code: string;
    event_date: Date;
    kind: string;
    cost_cents: number | null;
    notes: string | null;
  }): EquipmentEvent => ({
    id: r.id,
    siteId: r.site_id,
    occurredAt: r.event_date,
    kind: r.kind,
    label: `${r.equipment_code} ${r.kind}${r.notes ? ` — ${r.notes.slice(0, 80)}` : ''}`,
    costCents: r.cost_cents,
  });
  return {
    available: true,
    async notableEvents(siteId, startISO, endISO) {
      const rows = await prisma.equipmentEvent.findMany({
        where: {
          site_id: siteId,
          voided_at: null,
          event_date: { gte: dayKey(startISO), lte: dayKey(endISO) },
          kind: { in: ['downtime', 'maintenance', 'repair'] },
        },
        orderBy: { event_date: 'asc' },
      });
      return rows.map(toEvent);
    },
    async bigCostEvents(siteId, startISO, endISO, thresholdCents) {
      const rows = await prisma.equipmentEvent.findMany({
        where: {
          site_id: siteId,
          voided_at: null,
          event_date: { gte: dayKey(startISO), lte: dayKey(endISO) },
          cost_cents: { gte: thresholdCents },
        },
        orderBy: { cost_cents: 'desc' },
      });
      return rows.map(toEvent);
    },
  };
}
