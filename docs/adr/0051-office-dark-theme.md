# ADR-0051 — Office/manager surfaces adopt the Vision dark-space theme; the floor stays green

**Status:** Accepted (2026-07-15, operator-directed — Bill: "let's do this now");
floor-stays-green CONFIRMED by operator 2026-07-15 ("keep the floor green")
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

## Post-acceptance note — 2026-07-15 (operator confirmed: floor stays green)

The one open theming question this ADR left implicit — whether the
warehouse-floor iPad UI should eventually follow the office to deep-space —
was put to the operator after the AP go-live and answered directly: **"keep
the floor green."** The audience/environment split above is therefore the
settled, operator-ratified state, not a provisional one: `/operator/*` stays
on the ADR-0008 green theme indefinitely; no floor repaint is planned. This
closed O-9(b) in `docs/OPEN-ITEMS.md`. (The office sweep of the remaining
green `/dashboard/**` + `/admin/**` pages is still the C-16 follow-up.)

## Post-acceptance note — 2026-07-16 (C-16 sweep executed — all office surfaces repainted)

The follow-up sweep this ADR deferred is now done. Operator directive (Bill,
2026-07-16): **"everything goes to the new look except the floor iPads."** Every
remaining green office/manager surface was repainted to the deep-space theme as
an **in-place token swap** matching the AP reference (green-era chartreuse →
`dr3-cyan`; `dr3-green-deep` shells → `dr3-space` + `dr3-mist`; white/green
panels → the AP's `black/30` / `white/5` fills; `accent-dr3-green` →
`accent-dr3-cyan`). This was a class swap + contrast pass, **not** a redesign —
no logic, layout, or spacing changed. The optional `office-shell` extraction
from VisionShell that C-16 floated was **not** needed to reach the sweep goal
and is deferred (no green office pages depend on it).

**Surfaces repainted:**

- `/dashboard/[site]/*` — `cor`, `equipment`, `invoices`, `invoices/[id]`,
  `loads-inventory`, `ops`, `yard` (page shells + their `*Client` components).
- `/dashboard/ops/digests` (page + `DigestsClient`).
- `/admin/processed-units`, `/admin/production-report`.
- `/bonus/amendments`.
- `/login/locale-picker` (active-language accent).
- **App-global chrome:** `layout.tsx` PWA `themeColor` (`#00524C` → `#070C12`),
  `global-error.tsx` catastrophic fallback (green → deep-space), and the
  `UpdatePrompt` banner's reload CTA (already-dark banner; green button → cyan).

**Login & UpdatePrompt disposition (the two the sweep flagged for investigation):**

- **`/login` goes dark.** It is exclusively the **office Entra SSO door**
  (`login-form.tsx` is a single Microsoft Entra button; `login/page.tsx` was
  already `bg-dr3-space` with the Vision logo + cinematic intro). The floor
  iPad PIN path lives under `/operator`, **not** `/login`, so no floor flow
  regresses. Only the locale picker's active-button green remained; it is now
  cyan.
- **`UpdatePrompt` is theme-neutral by construction.** The banner mounts in the
  root shell over **every** surface (office + floor), and its container was
  already a self-contained deep-space card (`bg-dr3-space-2/95`,
  `border-dr3-cyan`). Only its reload button was still green; making it cyan
  keeps it consistent on the dark banner regardless of the surface beneath — so
  it reads correctly on both office and floor.
- **`layout` themeColor** is a single global PWA/browser-chrome value. It now
  matches the already-dark root `<body>`. The **floor iPads are unaffected**:
  iOS standalone PWAs take their status-bar treatment from
  `appleWebApp.statusBarStyle: 'black-translucent'`, not `themeColor`, which
  primarily frames the office/desktop chrome.

**Deliberately left green (per scope):** the floor tree (`/operator/*`, ADR-0008)
and `src/app/internal/cor-pdf/[id]/page.tsx` (a printed COR deliverable, not
office UI — PDF generation is out of scope). Semantic status colors
(`health-pill.tsx` lime/amber/red traffic-light dots) are not brand-green and
were left as-is.

**Invariant guard:** `src/app/office-dark-theme-sweep.test.tsx` statically walks
`src/app`, excludes `/operator` + `cor-pdf` + test files, and fails if any office
source carries a legacy green brand class — so a new green office page (or a
regression) breaks CI. It also asserts the floor tree still _has_ green, so the
exclusion can't silently become a lie.
