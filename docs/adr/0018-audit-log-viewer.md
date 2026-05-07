# ADR-0018: Admin Audit Log Viewer (T-014)

**Date:** 2026-05-06
**Status:** Accepted
**Supplements:** ADR-0007 (audit log), ADR-0017 (admin settings panel), ADR-0015 (i18n architecture)

## Context

ADR-0007 mandates an append-only audit log retained indefinitely;
the schema and write-path are wired across `pin-service`,
`load-service`, and `admin-users`. SPRINT-1-PLAN T-014 closes the
read-side of the contract: an admin-only viewer that lets Bill (and
any future admins) trace who did what to which row.

The acceptance criterion is short — "every mutation in the test
session has a corresponding audit row, UI renders the JSON readably"
— but the constraints around it are sharp:

- **Append-only** (CLAUDE.md hard rule #6, ADR-0007). The viewer
  cannot expose any edit / delete affordance, even hypothetically.
- **Admin only**. Per ADR-0017's pattern: page-layer `checkAdmin()`
  AND per-route `requireAdmin()` — never trust just one.
- **URL is the state** for filters (consistent with the loads list
  at `dashboard/[site]/loads`). Shareable, bookmarkable, refresh-
  safe.
- **No native `<form>`** for the filter apply button (CLAUDE.md hard
  rule #10). Apply is an `onClick` button that pushes a new URL.
- **English-only for v1** (ADR-0015 + ADR-0017): admin literals live
  in `src/app/admin/messages.ts` and never leak into the
  `en/es/ur` operator dictionaries.

## Decision

Ship `/admin/audit` as a server-rendered list with five filters
(actor, table, date-from, date-to, action multi-select), paginated
50 rows per page, with a per-row collapsible JSON-diff view.

### Routes

| Path                          | Method | Purpose                                      |
| ----------------------------- | ------ | -------------------------------------------- |
| `/admin/audit`                | GET    | viewer page                                  |
| `/admin/audit/load/[id]`      | GET    | resolver — looks up a load's site, redirects |
| `/api/admin/audit`            | GET    | JSON list endpoint                           |

The admin index already redirects `/admin -> /admin/users`; the
existing nav also gets a small "Audit log" link in the user-list
header so navigation between the two admin surfaces is obvious.

### URL contract

`/admin/audit?actor=<user-id>&table=<table_name>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>&action=<csv>&page=<n>`

- `actor` — user id (single-select, dropdown of managers + admins).
- `table` — `audit_log.table_name` value (dropdown of currently
  linkable tables plus any table observed in the current page so
  unfamiliar entries are still pickable).
- `from` / `to` — inclusive ISO dates, anchored at UTC midnight.
  `to` is widened by 24 h server-side so the upper bound is
  exclusive in SQL. Default range when neither is supplied: last
  7 days. Defaults are NOT injected into the URL — the server
  applies them silently and the filter UI shows them as the
  active draft.
- `action` — comma-separated `AuditAction` enum tokens; unknown
  tokens are dropped silently. Empty (or all-unknown) means "any
  action". Multi-select chips on the page.
- `page` — 1-based; absent page == page 1. Per page is fixed at
  50 in the page surface; the API accepts `per_page` up to 200
  for power-user / future-CSV-export use.

URL parsing + composition lives in
`src/lib/admin-audit-url.ts` and has unit tests covering every
shape.

### Append-only invariant

The route exports `GET` only. The audit-log integration test
asserts that `POST`, `PATCH`, `PUT`, and `DELETE` are all
`undefined`, so any future contributor who adds a write-path here
trips a CI failure. The data layer at `src/lib/admin-audit.ts`
similarly never calls `prisma.auditLog.update` or `delete` — only
`findMany` + `count`.

### Cross-link strategy

The audit log records `(table_name, row_id)` in a site-agnostic
shape, but the manager load detail lives at
`/dashboard/[site]/load/[id]` (site-scoped). Strategy:

- Linkable tables are an explicit allow-list:
  `LINKABLE_TABLES = ['users', 'inbound_loads']`. Adding a target is
  one constant edit + one branch in `buildTargetHref`.
- For each row in the page, we resolve "does the row still exist?"
  in a single bulk-IN query per table — never N round-trips.
  Soft-deleted users are still resolvable because soft-delete only
  flips `deleted_at`, the row stays readable.
- For `users`, link target is `/admin/users/[id]`.
- For `inbound_loads`, link target is `/admin/audit/load/[id]` — a
  thin server-component resolver that looks up the load's site and
  redirects to `/dashboard/[site]/load/[id]`. This avoids hard-
  coding the site lookup at the link site and keeps cross-site
  audit traversal consistent for admins.
- If the row is gone (hard-delete; rare today), the cell renders
  the table/id pair as plain text + a `(record removed)` notice
  rather than a broken link.
- For unlinkable tables (anything not on the allow-list), the cell
  is plain text. Not a 404.

### JSON diff renderer

Tiny in-house component, no dependency. Computes a key-by-key
classification — `added | removed | changed | unchanged` — and
renders a 3-column grid (key / before / after) with color tinting
per kind. Nested values render inline if they fit in ~60 chars,
otherwise as a `<pre>` snippet.

Rationale for not pulling in `react-json-view`:

- The audit dataset is row snapshots — flat-ish, ~10–20 keys, no
  graph cycles. A tree widget is overkill.
- Bundle weight: 0 KB delta vs ~40 KB gz for `react-json-view`.
- Custom highlighting (changed / added / removed) is awkward to
  layer on a generic tree component.

Pure helpers live in `src/app/admin/audit/diff-util.ts` so the
unit test can exercise them without loading React.

### Filter form

Per CLAUDE.md hard rule #10, the Apply trigger is a `<button
type="button" onClick>` that calls `router.push` — never a `<form>`.
Local working state lives in the client component between user
input and Apply; the URL is the persistent state. Reset clears
local state and pushes `/admin/audit` (no params).

### Test surface

- `src/lib/admin-audit-url.test.ts` — 18 tests covering parser,
  builder, ISO-date bounds, default range. Round-trip test
  verifies parse(build(x)) === x.
- `src/app/admin/audit/audit-diff.test.ts` — 13 tests covering
  `buildDiff` + `deepEqual` (insert / delete / change /
  unchanged / add-key / nested objects + arrays).
- `src/app/api/admin/audit/audit.test.ts` — 22 tests covering role
  gate (anon/operator/manager/admin), filter composition (actor,
  table, date, action, multi-filter), pagination (skip/take, page
  count, per-page clamp), row-existence resolver (linkable / gone
  / unlinkable), and the explicit append-only assertion that
  POST/PATCH/PUT/DELETE are not exported.

53 new tests; total fleet count grows from 51 to 104.

## Alternatives considered

- **Reuse the loads-list shell** as a generic table component. The
  loads list at `dashboard/[site]/loads` has its own filter +
  pagination shape. Lifting it into a shared helper would have
  added ~200 lines of abstraction and tied two unrelated surfaces
  to the same component lifecycle. The audit list re-implements
  the same patterns in ~200 lines — readable, no shared coupling.

- **Server-render the diff** instead of client-side expand. Diffs
  are hidden by default; pre-rendering 50 of them ships ~4–10 KB of
  HTML that nobody reads. The client expand is one `useState` on
  a Set + a button that flips inclusion — no extra round-trip.

- **A single Prisma `IN` query for both tables**. Postgres can do
  `(table, id) IN ((..),(..))` with a row constructor, but Prisma's
  type-safe API doesn't expose it cleanly. Two queries (one per
  table) are O(1) per page and the cost is negligible.

- **Pull `react-json-view` for the diff**. See JSON-diff section
  above — vetoed on bundle weight + custom-highlight awkwardness.

- **Extend the `audit` route to support CSV export**. Out of
  scope for T-014. The viewer is the contract; export is a
  follow-up.

- **Soft-render the list as Server Components only**. The expand-
  collapse mechanism wants client state; pre-expanding everything
  is wasteful. Hybrid: server emits the row data, client owns
  expand-state + URL navigation.

## Consequences

- New module: `src/lib/admin-audit.ts` (data layer; uses Prisma).
  Server-only. Not imported from any client component.
- New module: `src/lib/admin-audit-url.ts` (parser / builder /
  date bounds). Pure; safe for client + server import.
- New API route: `src/app/api/admin/audit/route.ts`. GET only.
- New page tree:
  - `src/app/admin/audit/page.tsx` (server component)
  - `src/app/admin/audit/AuditFilters.tsx` (`'use client'`)
  - `src/app/admin/audit/AuditList.tsx` (`'use client'`,
    expand-collapse state)
  - `src/app/admin/audit/AuditPagination.tsx` (`'use client'`)
  - `src/app/admin/audit/AuditDiff.tsx` (`'use client'`,
    rendering only)
  - `src/app/admin/audit/diff-util.ts` (pure helpers)
  - `src/app/admin/audit/load/[id]/page.tsx` (resolver)
- `src/app/admin/messages.ts` grows an `audit:` block with all
  user-visible strings. No literals leak into the audit
  components.
- Nav: `src/app/admin/users/page.tsx` gains a small "Audit log"
  link in the header. The user-edit page already has its own
  back link.
- 53 new tests pass under `npm test`. `npm run lint` and
  `npx tsc --noEmit` both green.

## References

- CLAUDE.md hard rules #6 (audit append-only), #10 (no `<form>`)
- ADR-0007 (audit log design)
- ADR-0015 (i18n architecture — admin surface stays English-only
  for v1)
- ADR-0017 (admin settings panel — establishes the gate /
  layout / messages-table conventions this viewer mirrors)
- SPRINT-1-PLAN T-014 (acceptance contract)
