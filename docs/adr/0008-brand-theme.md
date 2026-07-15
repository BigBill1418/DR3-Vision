# ADR-0008: Brand theme

**Date:** 2026-05-04
**Status:** Accepted

## Context

DR3 is a distinct brand from its parent SVdP. Confusing the two in the UI would mislead operators (who work for DR3) and undermine the visual signal that DR3 is the responsible operating entity for these mattress recycling activities.

SVdP's brand is **red and gold**. DR3's brand is **green and black**. The "D" in the DR3 logo is green; "R3" is black; a recycling-arrow symbol sits below the "3".

The frequency-analysis of `mattressrecycling.us` (DR3's public site) confirmed the palette below.

## Decision

The DR3 brand palette, locked in `tailwind.config.ts`:

| Token | Hex | Role |
|---|---|---|
| `--dr3-green-deep` | `#00524C` | Primary green; deep teal/forest |
| `--dr3-green` | `#49AD8E` | Secondary green; most-used accent |
| `--dr3-green-dark` | `#0B6662` | Tertiary green; pressed/active states |
| `--dr3-chartreuse` | `#EFFE8B` | Highlight; calls to action |
| `--dr3-cream` | `#FCFFD7` | Subtle background for cards |
| `--dr3-ink` | `#1A1A1A` | Body text and "R3" wordmark |

Typography: **Inter** for all UI text. No serif fonts, no decorative fonts.

Logo asset: **canonical SVG to be provided by Bill** at `public/brand/dr3-logo.svg` (see HANDOFF.md open decision #1). If only PNG exists, vector-trace before launch.

### Forbidden
- Red/black palette (this is SVdP, not DR3)
- Navy/gold palette (not affiliated)
- The Society of St. Vincent de Paul logo or any of its variants
- Substituting alternative greens "close enough" to the brand greens — use the exact hex values

### What "brand-correct" means at the placeholder stage
- Background: `--dr3-green-deep`
- Accent text: `--dr3-chartreuse`
- Body text: `--dr3-cream` (on dark background) or `--dr3-ink` (on light background)
- Logo (when provided): centered, sized appropriately for context

The placeholder page in T-001 (Sprint 1) is the first brand-correctness checkpoint. If the colors are wrong there, the build is wrong.

## Alternatives considered

- **Use SVdP's red/black palette** — incorrect identity; DR3 is the brand on the dock and on bills
- **Generic neutral palette (gray/white)** — abandons the brand opportunity; operators don't get a sense of what system they're using
- **Dark mode by default** — warehouse glare suggests a deep green base will read well outdoors and indoors; full dark mode (true black) is an extension to consider in V2

## Consequences

- The `tailwind.config.ts` file becomes a brand reference document; do not modify these tokens without an ADR superseding this one
- Component libraries (shadcn/ui) are themed against these tokens, not their defaults
- New screens must use only these tokens; introducing arbitrary hex values is a code-review failure
- The deep green `#00524C` is dark enough that white text on it has WCAG AA contrast; chartreuse on deep green has AA-Large contrast and should be reserved for headlines and CTAs, not body text

## References

- Charter §5.6 (Brand)
- mattressrecycling.us (DR3 public site, source of truth for palette)

## Post-acceptance note — 2026-07-15 (scope split with ADR-0051; floor green reconfirmed)

ADR-0051 split the app's theming by audience: office/manager surfaces adopt the
Vision deep-space theme, while this ADR remains the authority for the
**warehouse floor (`/operator/*`) and the public brand**. The operator
reconfirmed the floor side directly on 2026-07-15 ("keep the floor green") —
the green floor standard is settled, with no repaint planned.
