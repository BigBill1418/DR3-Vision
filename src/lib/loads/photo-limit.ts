// ADR-0109 — the ceiling on load photos, and WHAT it is counted over.
//
// One number, in one place, read by the browser and by the API route. It is a
// deliberate module rather than a literal at two call sites: a client that
// hides its "add another" affordance at a different number than the server
// refuses at is exactly the "control whose only outcome is a refusal" that
// CONTRIBUTING.md forbids on `/operator` (ADR-0074 Am.1).
//
// ## The scope is per (load, KIND) — not per load. Measured, not assumed.
//
// Handoff #264 Item 1 asked for "up to 3 photos total per load". That premise
// died on checking. Against production 2026-08-18:
//
//     photos_per_load n=2 loads=57
//     photos_per_load n=3 loads=21
//     photos_per_load n=4 loads=4
//     photos_per_load n=5 loads=4
//     photos_per_load n=6 loads=1
//
// An ORDINARY load already takes three photos — BOL, weight ticket, door-open —
// because they are three separate stages of the workflow. A per-load ceiling of
// 3 would have refused the door-open photo on every load that took a weight
// ticket, and the door-open capture is what starts the unload timer (ADR-0012
// §1). The cap Bill asked for would have stopped the floor on its first day.
//
// So the ceiling is per capture point: three photos wherever the flow asks for
// one. One required (unchanged), two optional and unnamed.
//
// ## This capability is not new. The BOUND is.
//
// `PhotoInput`'s button stayed live after a successful capture, so re-tapping it
// has always uploaded another photo of the same kind. Operators found it: 18
// (load, kind) pairs in production carry 2-4 rows with DISTINCT storage keys
// (not idempotency duplicates — genuinely separate captures), and `page.tsx`
// already carried the comment "Deduped: several rows of one kind (a retaken
// photo)". What shipped with this module is the bound, the count, and a named
// affordance — not a new pipeline.

/**
 * Photos one load may hold **of one kind**. One required by the flow, two
 * optional.
 *
 * Enforced in two places on purpose, and they must not drift — hence this
 * constant:
 *   - `photo-input.tsx` withdraws the "add another" control at the limit, so
 *     the floor is never offered a tap the server will refuse.
 *   - `/api/photos/confirm` refuses the write, because a client-side ceiling is
 *     a UI affordance and not an invariant. The offline queue replays that
 *     endpoint from a device whose bundle may be days old.
 */
export const MAX_PHOTOS_PER_KIND = 3;

/**
 * How many more photos of this kind the load can still take.
 *
 * Clamped at 0 rather than going negative: nine production loads already hold
 * more photos than this ceiling allows (one holds four BOLs), and those rows are
 * not retracted by introducing a limit — the cap governs new writes only. A
 * negative "remaining" would render as a negative count on the floor.
 */
export function photosRemaining(current: number): number {
  return Math.max(0, MAX_PHOTOS_PER_KIND - current);
}

/** Whether another photo of this kind may be written. */
export function canAddPhoto(current: number): boolean {
  return photosRemaining(current) > 0;
}
