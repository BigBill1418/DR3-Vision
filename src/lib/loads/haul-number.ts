// ADR-0090 A — "which truck is this?", answered in one place.
//
// Every operator surface identifies a load by source + carrier + BOL. That is
// enough right up until one collection site sends two trucks in a day, which is
// routine — and then the queue card, the unfinished-loads row and the load
// header are, to the operator's eye, the same card twice. JT asked for the haul
// number specifically so a paused load can be recognised as the one that was
// tapped by mistake.
//
// The haul number lives in TWO columns, for reasons that are historical but
// real, so the read is centralised here rather than inlined at each surface:
//
//   - `expected_loads.external_mymrc_haul_id` — NOT NULL on the parent slot the
//     operator tapped. This is the authoritative one for dock work.
//   - `inbound_loads.external_mymrc_haul_id`  — nullable, stamped by the MyMRC
//     bridge on rows that never had a parent slot (`inbound-bridge.ts`).
//
// Inlining a `?? ` chain at five call sites is exactly how `held-by-panel.tsx`
// came to label a `submitted` load "Counting" for five days (see
// `consumed-slot.ts`): the copies drift and nothing says so.

/** The two columns a haul number can live in, as every caller must select them. */
export interface HaulNumberSource {
  external_mymrc_haul_id: string | null;
  expected_load: { external_mymrc_haul_id: string } | null;
}

/** The `select` fragment that makes {@link haulNumberOf} answerable. */
export const HAUL_NUMBER_SELECT = {
  external_mymrc_haul_id: true,
  expected_load: { select: { external_mymrc_haul_id: true } },
} as const;

function present(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The haul number to show for a load, or NULL when it genuinely has none.
 *
 * Null is a real answer, not a failure: a walk-up drop-off (ADR-0085) has no
 * haul at all, and the surfaces render their existing BOL line instead. Callers
 * must not substitute a placeholder that looks like an identifier.
 */
export function haulNumberOf(load: HaulNumberSource): string | null {
  return (
    present(load.expected_load?.external_mymrc_haul_id) ?? present(load.external_mymrc_haul_id)
  );
}
