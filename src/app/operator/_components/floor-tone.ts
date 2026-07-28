// ADR-0008 / ADR-0051 — the FLOOR palette for the shared nav-pill primitive.
//
// This lives in the operator tree deliberately. The office dark-theme sweep
// (`office-dark-theme-sweep.test.tsx`) forbids green brand classes anywhere
// under `src/app` except `app/operator/**`, because the office adopted the
// deep-space theme while the floor iPads stay green (operators work outdoors
// and need the high-contrast green in daylight). Putting the green tone here
// keeps that invariant true statically rather than by convention.
//
// Chartreuse is the ADR-0008 CTA highlight; the ring offset is black because
// the pills sit on FloorChrome's translucent black band, which spans both the
// black pre-auth screens and the green working screens.
export const GREEN_TONE =
  'border-dr3-cream/40 text-dr3-cream hover:border-dr3-chartreuse hover:text-dr3-chartreuse focus-visible:ring-dr3-chartreuse focus-visible:ring-offset-black';
