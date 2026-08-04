// Type surface for the (JS) ADR-0062 equipment-master seed's ADR-0075 merge
// guard, so a vitest test can import it under `allowJs: false`. The seed's
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of these types is the test).

/** The subset of an `equipment` row the seed reads to decide create/update. */
export interface SeedEquipmentRow {
  id: string;
  category: string;
  is_active: boolean;
  /** ADR-0075 D5 — non-null means this row was merged away; follow it. */
  merged_into_id: string | null;
}

/** Returned when the name matched a merged row whose survivor is gone. */
export const MERGED_TARGET_MISSING: unique symbol;

/**
 * The row this seed should WRITE for a `(site_id, display_name)` pair — which is
 * NOT always the row the name matches.
 *
 * A merged loser keeps its name, so a naive name match would let the seed write
 * `is_active = true` back onto it and silently undo a merge (ADR-0075 D5). This
 * follows `merged_into_id` ONE hop to the survivor.
 *
 * Returns the target row, `null` when the name is not in the registry (the
 * caller's create branch), or {@link MERGED_TARGET_MISSING} when the survivor is
 * gone — which the caller must SKIP rather than fall back to the loser.
 */
export function resolveSeedTarget(
  prisma: unknown,
  site_id: string,
  display_name: string,
): Promise<SeedEquipmentRow | null | typeof MERGED_TARGET_MISSING>;
