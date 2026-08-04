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

/// One selectable equipment option (active, unmerged; fleet-wide since 2026-07-28).
export interface EquipmentOption {
  id: string;
  displayName: string;
  category: EquipmentCategory;
  /**
   * ADR-0075 — the site the asset is registered to.
   *
   * The picker has been fleet-wide since 2026-07-28, so an approver sees both
   * yards' assets in one flat list with nothing to tell them apart. When two
   * yards carry similar names that is a coin flip, and a wrong pick is filed
   * against an approved invoice. Carrying the site makes the option honest about
   * which registry it came from.
   */
  siteId: string;
  /** Human-readable form of {@link siteId} — what the picker actually renders. */
  siteCode: string | null;
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
  const [rows, sites] = await Promise.all([
    prisma.equipment.findMany({
      // ADR-0075 D4 — a row merged into another asset is not a thing any more.
      // Leaving it selectable would let an approver file TODAY's invoice against
      // the duplicate a merge just retired, re-creating the split by hand.
      where: { is_active: true, merged_into_id: null },
      orderBy: { display_name: 'asc' },
      select: { id: true, display_name: true, category: true, site_id: true },
    }),
    // Two rows. Resolved here rather than shipped as a bare id because the picker
    // has to RENDER something a human recognises, and `Equipment` has no Prisma
    // relation to `Site` (bare FK per the schema comment).
    prisma.site.findMany({ select: { id: true, code: true } }),
  ]);
  const codeById = new Map(sites.map((s) => [s.id, s.code]));
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    category: r.category as EquipmentCategory,
    siteId: r.site_id,
    siteCode: codeById.get(r.site_id) ?? null,
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
    // `merged_into_id: null` tracks `listSiteEquipment` exactly (ADR-0075 D4).
    // These two MUST agree in BOTH directions: a merged row the picker no longer
    // offers must also be refused here, or a stale tab still holding the option
    // would file a NEW approval against a retired duplicate.
    where: { id: { in: unique }, is_active: true, merged_into_id: null },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApEquipmentInvalidError(
      `Selected equipment is not available (unknown, inactive or merged): ${missing.join(', ')}`,
    );
  }
}
