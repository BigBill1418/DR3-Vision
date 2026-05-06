# ADR-0014: Canonical brand mark + dark-mode auth surfaces

**Date:** 2026-05-06
**Status:** Accepted
**Supplements:** ADR-0008 (brand theme), ADR-0012 §5
**Closes:** HANDOFF open decision #1 (canonical DR3 logo SVG)

## Context

ADR-0012 §5 left the canonical DR3 logo as a TBD: T-001 shipped a
text wordmark while waiting for Bill to provide the canonical mark.
The placeholder went through three iterations on 2026-05-06:

1. Pure text wordmark in Inter (T-001 baseline).
2. Inline-SVG eye-as-"o" trial — concentric circles in cream / green /
   ink, replacing the lowercase "o" in "Vision".
3. Bill provided `public/brand/dr3-vision-logo.jpg` (1168×784, JPG)
   — a production-quality realization of the eye-as-"o" treatment in
   cyan iris on a dark space backdrop. Wired in as the placeholder
   hero on a black background.

Bill confirmed (2026-05-06) that this is the canonical DR3-Vision
mark, used **everywhere** a brand mark appears. He also locked in
the dark backdrop for the **login page** alongside the placeholder.

## Decision

### 1. The canonical DR3-Vision mark is `public/brand/dr3-vision-logo.jpg`

This is the brand mark used in:

- The placeholder landing page (current)
- The login page (T-003)
- Any future splash, onboarding, app-shell brand strip, marketing
  page, or PDF header that needs a DR3-Vision identity

When a future ticket needs an SVG variant for sharper rendering at
small sizes (favicon, app-shell header at 32 px, PDF embed at low
resolution), the SVG drops in alongside as `public/brand/dr3-vision-logo.svg`
without superseding the JPG. Both coexist; ticket authors pick the
right format for the surface.

### 2. Dark-backdrop on auth surfaces (login + placeholder)

The placeholder route and the login route (T-003) both use a black
background to match the canonical mark's space backdrop. The brand
mark + the page chrome around it read as one piece.

The cyan accent in the logo is asset-internal — it does **not**
become a token in `tailwind.config.ts`. The DR3 brand palette tokens
(`dr3-green-deep`, `dr3-green`, `dr3-chartreuse`, `dr3-cream`,
`dr3-ink`) from ADR-0008 are unchanged.

### 3. Operator + manager surfaces stay green-palette

Operator iPad screens (the dock workflow — T-005 through T-009) and
the manager portal (T-010 through T-013) keep the
`--dr3-green-deep` body bg and the rest of the ADR-0008 palette.
Rationale: those are working surfaces optimized for ergonomics
(forklift-mounted iPads in warehouse light, manager dashboards in
office light); the dark backdrop is for identity surfaces only.

Each non-auth surface that wants the brand mark renders it on the
green palette without the dark backdrop. The logo's JPG bg will
visibly clip on green; an SVG-with-transparent-bg variant becomes
load-bearing the moment the mark needs to sit on the green palette.
File a follow-up to commission that SVG when the first
non-auth-surface request lands.

## Consequences

- ADR-0012 §5 + HANDOFF open decision #1 are closed.
- T-003 (login page) ships against the locked dark + canonical-mark
  treatment without re-litigation.
- The tailwind config doesn't grow a `dr3-cyan` token; the cyan is
  the logo's, not the system's.
- A future SVG variant of the mark is anticipated but not blocking.
- `src/app/layout.tsx` body bg stays `--dr3-green-deep`; auth-surface
  routes (placeholder, `/login`) override locally with `bg-black` per
  `src/app/page.tsx`'s pattern.

## References

- ADR-0008 — original brand-theme decision
- ADR-0012 §5 — placeholder wordmark interim
- `public/brand/dr3-vision-logo.jpg` — the canonical asset
- `src/app/page.tsx` — reference implementation of the dark + mark layout
- `CHANGELOG.md` — 2026-05-06 canonical-logo entry
