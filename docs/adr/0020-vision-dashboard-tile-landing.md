# ADR-0020: Vision Dashboard tile landing

**Date:** 2026-06-05
**Status:** Accepted

## Context

Today, `https://dr3-vision.svdp.us/` serves a static "coming soon" placeholder. Users who authenticate via Entra SSO land directly on whichever feature page they navigate to. There's no single product entry point that surfaces all of DR3-Vision's capabilities.

With Sprint 2 adding the Bonus Management System and a roadmap of V2.1+ work, the product needs a tile-based launcher — a "Vision Dashboard" — that:

1. Replaces the "coming soon" landing as the authenticated entry point
2. Surfaces all active capabilities as discoverable tiles
3. Shows V2.1+ work as deactivated tiles, conveying the product roadmap
4. Is role-aware: each user sees only the tiles they have access to
5. Is visually distinctive — DR3 brand presence, heavy visual elements, not a generic admin panel

## Decision

Implement the Vision Dashboard at the root route `/` for authenticated users. Unauthenticated requests redirect to `/login` per the existing middleware.

### Layout

A single full-width section on a DR3-green branded surface (`#00524C`) with:

- **Header band:** DR3 Vision wordmark (chartreuse "D" + cream "R3" lockup) + tagline "Operations · compliance · payroll" on the left; user info (name, role, avatar) on the right
- **Background element:** large faded "DR3" or actual logo SVG positioned bottom-right at low opacity as a heavy brand element
- **Active section:** label "ACTIVE" in chartreuse small-caps; grid of active tiles
- **Coming Soon section:** label "COMING SOON" in chartreuse small-caps; grid of deactivated tiles
- **Footer:** systems-operational pill (with status dot color-coded to /healthz subsystem state) + version string (deployed git short SHA)

Brand colors per ADR-0008 throughout. Inter typography. Cream `#FCFFD7` for active tile backgrounds; chartreuse `#EFFE8B` for the featured tile (Bonus Management on launch); outline-only treatment for deactivated tiles (low-opacity cream).

### Tiles

#### Active tiles (Sprint 2 cutover state)

| Tile                 | Icon (Tabler)      | Route                              | Roles                                   |
| -------------------- | ------------------ | ---------------------------------- | --------------------------------------- |
| Bonus Management     | ti-coin            | `/bonus`                           | admin, manager (Woodland or both-sites) |
| Operations Dashboard | ti-dashboard       | `/dashboard`                       | admin, manager                          |
| Compliance           | ti-shield-check    | `/dashboard/[site]/compliance`     | admin, manager                          |
| Reconciliation       | ti-arrows-exchange | `/dashboard/[site]/reconciliation` | admin, manager                          |
| Exports & Reports    | ti-file-export     | `/dashboard/exports`               | admin, manager                          |
| Admin & Audit        | ti-settings        | `/admin`                           | admin only                              |

The Bonus Management tile is **featured** on launch — chartreuse background, "NEW" pill in top-right, slight size emphasis. Featured treatment ages out one sprint after ship (T-118 in V2.1 backlog: "Remove NEW pill from Bonus Management tile").

#### Coming Soon tiles (deactivated, visible for roadmap signaling)

| Tile                    | Status  | Target                                                                                                        |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| Bulk Data Upload        | V2.1    | Historical backfill, source onboarding                                                                        |
| Photo Annotation Canvas | V2.1    | Operator markup tools (descoped from T-007)                                                                   |
| Processor Form Workflow | V2.1    | Deconstruction-line tracking + bonus integration (ADR-0011)                                                   |
| CIP Capture             | V2.2    | Consumer drop-off, California program (ADR-0010)                                                              |
| MRC API Integration     | Backlog | Replaces Playwright scraping, pending MRC's Salesforce team                                                   |
| Observability           | V2.1    | GlitchTip + Loki + Tempo + Grafana surfacing (now Sprint 2 via ADR-0022 — tile flips active when T-122 ships) |

### Role-aware visibility

The tile grid filters by role at server-render time. Each tile's visibility is determined by a `canSeeTile(session, tile)` helper in `src/lib/dashboard-tiles.ts`:

- **Admin (Bill, Kelsey):** all active tiles visible
- **Operations Manager (Morena — no `primary_site_code`):** all active tiles except Admin & Audit
- **Woodland Manager (Janette — `primary_site_code = woodland`):** Bonus Management, Operations, Compliance, Reconciliation, Exports (no Admin)
- **Eugene Manager (Rick — `primary_site_code = eugene`):** Operations, Compliance, Reconciliation, Exports (no Bonus Management, no Admin)
- **Operator:** never reaches the Vision Dashboard. Operators authenticate via PIN at `/operator`, not via Entra SSO. The route `/` redirects them to `/operator` after PIN verify.

Tiles that don't apply to the current user are entirely omitted (not greyed) — they are not part of "Coming Soon" since they exist for other users today. Coming Soon tiles are V2.1+ for everyone.

### Route changes

- **`/` (root):** new behavior. Authenticated → Vision Dashboard. Unauthenticated → `/login` (middleware unchanged). Was: static "coming soon".
- **`/dashboard` (no site):** new behavior. Admin → role-appropriate site picker. Single-site manager → redirect to `/dashboard/[their-site]`. Operations manager → admin-like site picker.
- **Existing per-site routes (`/dashboard/[site]/*`, `/admin/*`, etc.):** unchanged.
- **`/operator/*`:** unchanged. The Vision Dashboard does not link into operator routes — operators have their own PIN flow.

### Avatar

The user info on the right surfaces:

- **Name** (from Entra `name` claim)
- **Role** ("Administrator" | "Manager" | "Operations Manager")
- **Avatar:** Microsoft Graph profile photo via `GET /me/photo/$value` if available; falls back to initials in a chartreuse-on-deep-green circle. This is one extra Graph call per session, cached for 24h in the session cookie. The `User.Read` permission already granted to the Entra app (ADR-0016) is sufficient — no new permissions.

### Health status indicator

The footer "All systems operational · last sync N min ago" pill reflects `/healthz` subsystem state:

- **Green** (`#97C459`): all subsystems healthy
- **Amber** (`#F0993E`): non-critical degradation (MyMRC scrape failed last tick, R2 latency high)
- **Red** (`#E24B4A`): critical degradation (db_ok false, app cannot serve)

Status polled every 30s from the dashboard. Tap opens an inline expandable panel showing per-subsystem status (db, R2, MyMRC last-tick, ntfy publisher, Graph API). The per-subsystem detail is the user-facing surface of the observability work in ADR-0022.

## Alternatives considered

- **Keep "coming soon" landing, link directly into per-feature routes via header nav.** Rejected. Doesn't surface the product roadmap; doesn't make Bonus Management discoverable for Janette and Morena; misses the visual identity opportunity.
- **Generic admin shell (sidebar + breadcrumbs).** Rejected. Functional but generic. The "heavy visual elements, gorgeous" requirement asks for distinctive presence.
- **Show every tile to every user, with greyed-out treatment for tiles they can't access.** Rejected. Creates confusion ("why can't I click this?") and leaks role structure across users.
- **Defer the dashboard to a later sprint, ship just `/bonus` for cutover.** Rejected. Bill specifically wants the new landing in this sprint — the "coming soon" framing undersells what's actually live.

## Consequences

- The root route `/` is now a substantive feature, not a placeholder. Future product changes (new features, deprecations) will be visible here first.
- The Bonus Management "NEW" pill is the canonical pattern for new-tile launches; subsequent V2.1+ tiles get the same treatment when they ship.
- Role visibility logic is centralized in `src/lib/dashboard-tiles.ts`. Changes to role scope (e.g., a new manager role variant) require updating this file plus the role gating on the underlying routes — but not the tile UI itself.
- The Microsoft Graph profile photo call adds a small latency on first dashboard load per session. Acceptable for the polish gain. If Graph is unreachable, falls back to initials silently.
- The Vision Dashboard is the visible product surface for the SVdP/DR3 staff who don't touch operator iPads. First impressions ride on getting the visual polish right.

## References

- ADR-0008 (Brand theme — colors, typography)
- ADR-0014 (Canonical brand mark lock — logo asset standard)
- ADR-0016 (Entra ID SSO — provides session, role, name)
- ADR-0017 (Admin Settings panel — example of role-gated route group)
- `docs/SPRINT-2-PLAN.md` (T-115 through T-117 — tile landing tickets)

## Note — 2026-07-15 (AP Approvals tile + condensed grid; AP overhaul pass)

- **New tile `ap-approvals`** (route `/dashboard/ops/ap`, `FileCheck` icon) under a
  new **`TileScope 'ap-approver'`**. The scope is gated on a new `isApApprover`
  param threaded through `canSeeTile` / `visibleTiles` (defaults `false`, mirroring
  the `isSuperAdmin` pattern). The launcher (`src/app/page.tsx`) resolves it via
  `canActOnApRequest` (admin OR active `ap_approvers` roster member — roster
  membership, **not** site reach: single-site roster managers Rick/Janette pass) and
  sets a live pending-count **badge** (`pendingApCount`) as an optional
  `DashboardTile.badgeCount` rendered as a cyan pill on the tile.
- **Condensed grid.** Tiles tightened for tap-density on office iPads: `p-6`→`p-4`,
  icon chip `h-11 w-11`→`h-9 w-9`, label `text-lg`→`text-base`, description
  `text-sm`→`text-xs` + `line-clamp-2`, with a `min-h-[88px]` floor (iPad tap
  target). The shell grid goes `sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4`,
  `gap-5`→`gap-3`.

## Amendment — 2026-07-22 (Operations Dashboard tile disable → re-enable; #156)

The Decision table above (line 41) presents **Operations Dashboard** as an active tile
since Sprint 2. That was not continuously true: the tile was paused to `coming-soon`
on **2026-06-06** "while the underlying surfaces are reworked," and is now **`active`
again** for the Eugene iPad go-live. This amendment records the full cycle so a reader
of the Decision table alone isn't misled.

- **Re-enable (`src/lib/dashboard-tiles.ts`, `key: 'operations'`, still `manager+`).**
  The surfaces the pause waited on have since landed — processed-units daily close,
  loads/inventory running balance, Terex throughput/downtime/cost, the MyMRC mirror
  backfill, commodity-payment aging, the compliance slate, bonus close — so
  `/dashboard` now leads with a comprehensive overview instead of a bare site list.
  Re-enable is the one-field flip the registry comment always promised.
- **Born LIVE, not behind a rollout ramp.** The re-enable ships directly to production
  for the Eugene go-live (not gated to `pilot` first) — a deliberate decision given the
  overview aggregates only existing source-of-truth modules and re-derives no
  billing/compliance number.
- **New per-site Operations Overview** (`src/app/dashboard/[site]/page.tsx` leads with
  `overview/OpsOverviewPanel.tsx`, fed by `src/lib/dashboard/ops-overview.ts` →
  `computeOpsOverview`): at-a-glance cards + compact tables for today's active/arrived
  loads, processing-close status, floor inventory (program / non-program / total),
  Terex throughput + downtime + cost, contract recycling/recovery rates, the
  seven-tile compliance slate, commodity-payment aging, bonus-period standing, and
  **MyMRC sync freshness** per feed (Pacific time so staleness is visible). Each panel
  deep-links to its source surface and degrades to an explicit note (never a crash) on
  read failure.
- **Combined both-sites view** on the `/dashboard` picker for admin / all-sites
  managers (`computeSiteSummary`): Eugene + Woodland side-by-side. Single-site managers
  are unaffected.
- **iPad-first legibility** per ADR-0014: dark Vision palette, no sub-12px real-data
  text, WCAG-AA contrast, ≥44px touch targets, tables scroll inside their own
  container (zero horizontal page scroll verified 768×1024 / 1024×768 / 390 / 1440 via
  Playwright). Refresh is the 30s ops cadence (`OverviewPoller`). Site isolation
  (hard rule #2) preserved — every read scoped to the resolved site id; the shared
  MyMRC dock schedule is labeled "all sites" since it carries no site discriminator.
