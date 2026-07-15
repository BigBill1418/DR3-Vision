# ADR-0051 — Office/manager surfaces adopt the Vision dark-space theme; the floor stays green

**Status:** Accepted (2026-07-15, operator-directed — Bill: "let's do this now")
**Date:** 2026-07-15
**Relates to:** ADR-0008 (brand theme — green & black, the floor standard), ADR-0020
(Vision Dashboard — the logo-keyed dark-space theme this generalizes), ADR-0046
Amendment 4 (the AP overhaul pass that repainted the first office surface)
**Series:** office visual reconciliation

## Context

ADR-0008 locked the DR3 brand to **green and black**, and the operator (floor) iPad
surfaces under `/operator` are built to it. But ADR-0020 introduced a second,
distinct visual identity for the **Vision Dashboard** front door (`/`): a logo-keyed
**deep-space** theme sampled from `public/brand/dr3-vision-logo.jpg` — near-black
field (`dr3-space`), cyan glow (`dr3-cyan`, the "eye"/"Vision"), steel-blue accents,
and cool off-white text (`dr3-mist`). Every office/manager surface reached _from_
that dashboard, however, still rendered in the older green theme (`dr3-green-deep` +
plain white text), so a manager crossing from the dashboard into a feature page hit
a jarring theme seam.

The AP overhaul pass (2026-07-15) had to repaint the AP queue anyway (it was the
most-jarring green island directly under the new dashboard). That forced the
question this ADR settles: **which theme do office surfaces belong to, and does that
contradict ADR-0008?**

## Decision

- **Office/manager surfaces adopt the Vision deep-space theme** (`dr3-space` /
  `dr3-mist` / `dr3-cyan` / `dr3-steel`), so the dashboard and everything reached
  from it read as one product. Cyan replaces the green-era chartreuse as the office
  accent/selection color.
- **The floor (`/operator/*`) stays green** (ADR-0008). It is a different audience
  (processors on shared iPads), a different environment, and a different, already-
  shipped visual contract. **This ADR does not touch the floor.**
- **ADR-0008 is reconciled, not overturned.** ADR-0008 remains the authority for the
  floor and the public brand (mattressrecycling.us). The deep-space theme is the
  **office/manager** skin of the same brand — the logo it is keyed to _is_ the brand
  mark (ADR-0014). Green and cyan are two faces of one identity, split by audience.
- **This pass repaints only the AP queue** (`/dashboard/ops/ap` — page shell +
  `ApQueueClient` tabs/selection accents; the message-body iframe stays `bg-white`
  because it renders untrusted document content). The remaining office surfaces
  (`/dashboard/**`, `/admin/**`) are a **follow-up sweep**, out of scope here so the
  AP overhaul could ship without a fleet-wide repaint.

## Alternatives considered

- **Repaint every office surface in this pass.** Rejected — too large a diff to
  ride the AP overhaul; risks regressions across unrelated pages under deadline.
- **Keep AP green to match the other office pages.** Rejected — it leaves the worst
  seam (dashboard→AP is the most-trafficked office crossing) and defers the decision
  the operator already made.
- **Re-skin the floor to deep-space too.** Rejected — the floor is green by ADR-0008
  for a distinct audience/environment; no operator ask, real regression risk.

## Consequences

- A follow-up sweep will repaint the rest of `/dashboard/**` and `/admin/**` to the
  deep-space theme; until then those pages remain green (a known, temporary seam).
- New office/manager surfaces should be built on the deep-space tokens from the
  start (`dr3-space*`, `dr3-mist*`, `dr3-cyan*`, `dr3-steel*`), not the green tokens.
- ADR-0008's green tokens remain valid and in use (floor, public brand); they are
  not deprecated — the split is by audience, and the tailwind palette keeps both.

## References

- ADR-0008 (Brand theme — green & black; floor + public standard)
- ADR-0014 (Canonical brand mark lock — the logo the deep-space theme is keyed to)
- ADR-0020 (Vision Dashboard — origin of the deep-space theme)
- ADR-0046 Amendment 4 (AP overhaul pass — repainted the first office surface)
