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
