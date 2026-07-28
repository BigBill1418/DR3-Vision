# ADR-0064: An always-visible back bar on the manager surfaces

**Date:** 2026-07-27
**Status:** Accepted — partially superseded by [ADR-0065](0065-ipad-per-surface-rollout-gates-and-app-chrome.md)
**Supplements:** ADR-0017 (admin surface is English-only), ADR-0020 (Vision Dashboard at `/`)

> **Backfill note.** This ADR was referenced by the code it governs
> (`src/app/_components/back-to-dashboard.tsx` and the three route-group
> layouts + their tests) but the file itself was never committed alongside PR
> #163. It is written here from the shipped implementation so the six source
> files that cite "ADR-0064" resolve to a real record. The decision text
> describes what shipped; it is not a retroactive re-decision.

## Context

The manager surface is three route groups — `/dashboard` (21 pages), `/bonus`
(8) and `/admin` (27). None of them had a group layout carrying navigation, and
individual pages carried back links only where an author happened to add one.
The result: ~30 pages with **no in-app path back to the Vision Dashboard** at
`/`. The only way out was the browser Back button, which on a deep-linked page
(the common case — links arrive by email) goes nowhere useful.

`/admin` had no group layout at all.

## Decision

1. **One shared bar, mounted in the route-group layouts** — not a per-page
   edit. `src/app/_components/back-to-dashboard.tsx` is wired into
   `dashboard/layout.tsx`, `bonus/layout.tsx` and a newly created
   `admin/layout.tsx`. Every nested page inherits it with zero page edits.
2. **Back is a real `<Link href="/">`, never `router.back()`.** Deterministic,
   SSR-safe, and independent of how the user arrived. `HOME_ROUTE` is the
   single source of that path.
3. **Two exports, because `/admin` has no I18nProvider** (ADR-0017 —
   English-only for v1). `BackToDashboardBar` is presentational and takes
   explicit labels; `BackToDashboardNav` resolves EN/ES/UR via `useT()` and is
   used by the dashboard + bonus groups.
4. **≥44px touch target, persistent bordered pill, visible focus ring.** The
   affordance must read as tappable without hover (managers do use iPads) and
   must be keyboard-reachable.

## Alternatives considered

- **Per-page back links.** Rejected: 56 edits, and the next page added would
  forget one. The defect being fixed was precisely that per-page navigation
  drifts.
- **`router.back()`.** Rejected: history depth is not a navigation model. After
  a `revalidatePath` + `redirect` the previous entry may not be where the user
  thinks they came from.
- **A full sidebar / app shell.** Rejected as out of proportion to the problem;
  the ask was "let me get home".

## Consequences

- Every manager page gains a persistent, translated way home for the cost of
  three layout edits.
- `/admin` gains a group layout it did not previously have — a place for future
  admin-wide chrome.
- **Known gap at the time of writing:** the bar carries _back_ only. There is
  still no sign-out control anywhere on the manager surface, so a manager's only
  way out of a session is clearing cookies. ADR-0065 closes this by extending
  the bar into a full `ManagerChrome` (back + Log Out) and replaces
  `back-to-dashboard.tsx` with `manager-chrome.tsx`.
