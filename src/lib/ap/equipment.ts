// ADR-0046 Amendment 5 (D-M5-6) — equipment/vehicle linking for the structured
// Approve path.
//
// The approver panel multi-select reads the ACTIVE equipment for the decision's
// site (Woodland/Eugene) from the `equipment` master and writes one
// `ap_equipment_links` row per pick — OR a single `is_not_equipment_related` row
// for the explicit-none choice (mutually exclusive). The registry is admin-managed:
// the approver panel may only REFERENCE existing rows, never create them (hard rule
// #3). This module is the server trust boundary — the decide route validates the
// submitted equipment ids against the site here, never trusting the client list.

import type { PrismaClient } from '@prisma/client';
import type { EquipmentCategory } from './extraction/types';

/// One selectable equipment option (site-filtered, active only).
export interface EquipmentOption {
  id: string;
  displayName: string;
  category: EquipmentCategory;
}

/**
 * The ACTIVE equipment registered to a site, alphabetical by display name — the
 * option set for the Approve-panel multi-select.
 *
 * ⚠ NOT site-filtered — operator directive 2026-07-28, which OVERRIDES ADR-0046
 * Amendment 5 (D-M5-6) "the site-filtered equipment option list". See the
 * amendment-history note in `docs/adr/0046-*.md`.
 *
 * Why: the fleet is shared. An invoice arriving at either site can be for any
 * asset — an over-the-road trailer, a tractor, a machine that moved between
 * facilities — and the SVdP machine list this registry was seeded from
 * (ADR-0062) carries no reliable DR3-site attribution at all: it has no "DR3
 * Eugene" facility, so rows were mapped coarsely by jurisdiction. Site-filtering
 * that data would hide the very asset an approver is looking at, with no way to
 * reach it. Whole-fleet selection is the honest behavior until the registry
 * carries real per-asset location.
 *
 * This does NOT relax CLAUDE.md hard rule #2: the DECISION is still filed to
 * exactly one site (or `filed_not_dr3`), still gated by `requireApApprover`, and
 * still audited. Only the reference list is fleet-wide.
 */
export async function listSiteEquipment(prisma: PrismaClient): Promise<EquipmentOption[]> {
  const rows = await prisma.equipment.findMany({
    where: { is_active: true },
    orderBy: { display_name: 'asc' },
    select: { id: true, display_name: true, category: true },
  });
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    category: r.category as EquipmentCategory,
  }));
}

/** Thrown when submitted equipment ids don't all resolve to ACTIVE rows on the site. */
export class ApEquipmentInvalidError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'ApEquipmentInvalidError';
  }
}

/**
 * Validate that EVERY submitted equipment id is an ACTIVE row in the registry.
 * Throws {@link ApEquipmentInvalidError} on any id that is unknown or inactive —
 * a decision must never link equipment the approver couldn't legitimately have
 * seen in the picker (defense against a hand-crafted payload). No-op for an
 * empty list.
 *
 * ⚠ The SITE check was removed 2026-07-28 by operator directive, in lockstep with
 * `listSiteEquipment` above. These two MUST agree: if the picker offers the whole
 * fleet while this still filtered by site, every cross-site pick would render fine
 * and then 400 on save — a broken approval path. The remaining checks (exists +
 * active) are still a real trust boundary and are deliberately kept.
 */
export async function assertEquipmentForSite(
  prisma: PrismaClient,
  equipmentIds: readonly string[],
): Promise<void> {
  if (equipmentIds.length === 0) return;
  const unique = Array.from(new Set(equipmentIds));
  const rows = await prisma.equipment.findMany({
    where: { id: { in: unique }, is_active: true },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApEquipmentInvalidError(
      `Selected equipment is not available (unknown or inactive): ${missing.join(', ')}`,
    );
  }
}
