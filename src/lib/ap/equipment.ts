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
 * option set for the Approve-panel multi-select. `siteId` is a resolved sites.id
 * (the panel's site CODE is resolved to an id upstream).
 */
export async function listSiteEquipment(
  prisma: PrismaClient,
  siteId: string,
): Promise<EquipmentOption[]> {
  const rows = await prisma.equipment.findMany({
    where: { site_id: siteId, is_active: true },
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
 * Validate that EVERY submitted equipment id is an ACTIVE row belonging to the
 * decision's site. Throws {@link ApEquipmentInvalidError} on any id that is unknown,
 * inactive, or registered to a different site — a decision must never link
 * equipment the approver couldn't legitimately have seen in the site-filtered
 * picker (defense against a hand-crafted payload). No-op for an empty list.
 */
export async function assertEquipmentForSite(
  prisma: PrismaClient,
  siteId: string,
  equipmentIds: readonly string[],
): Promise<void> {
  if (equipmentIds.length === 0) return;
  const unique = Array.from(new Set(equipmentIds));
  const rows = await prisma.equipment.findMany({
    where: { id: { in: unique }, site_id: siteId, is_active: true },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApEquipmentInvalidError(
      `Selected equipment is not available for this site (unknown, inactive, or wrong site): ${missing.join(', ')}`,
    );
  }
}
