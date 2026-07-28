# ADR-0063: The admin equipment-master screen, and the uniqueness key it makes real

**Date:** 2026-07-28
**Status:** Accepted
**Supplements:** ADR-0017 (admin settings panel) + its Amendment 1, ADR-0062 (equipment seed),
ADR-0046 Amendment 5 (AP equipment linking)
**Constrained by:** ADR-0046 **Amendment 7** (fleet-wide equipment selector, merged the same
day) — it reversed D4's site-lock, raised the weight of `is_active` (D4a), and left the
per-site-uniqueness exposure recorded under Consequences
**Closes:** `docs/OPEN-ITEMS.md` C-27

## Context

ADR-0062 loaded 554 assets into `equipment` and closed the immediate AP problem: approvers
had an empty picker and every one of the 12 `ap_equipment_links` rows written since AP
go-live was `is_not_equipment_related=true` by force, not by judgement.

But it closed that gap with a **script**. The AP code has always described the registry as
"admin-managed" and `/api/ops/ap/equipment` is deliberately read-only "because creation is
admin-only" — yet the admin create/edit surface was never built. The only route under
`/api/admin/equipment` was the ADR-0048 D3 Terex _history_ importer, which writes
`equipment_events`, a different table. So every future fleet change — a new truck, a
scrapped trailer, a re-categorised machine — required another run of
`scripts/seed-equipment-master.mjs` against production. That is C-27.

This ADR is the screen. Most of its shape is not a decision at all: ADR-0017 already fixed
the admin-surface pattern (server-component list with a URL-driven filter bar, `checkAdmin()`
on the page and `requireAdmin()` re-checked in every handler, a discriminated-union PATCH,
audit rows written inside the mutation's own transaction, every literal in
`src/app/admin/messages.ts`). What follows is only what ADR-0017 does **not** already cover.

## Decisions

### D1 — Deactivate is the only removal. There is no delete endpoint.

`ap_equipment_links.equipment_id` is `onDelete: Restrict`, and those rows are
financial-approval evidence: they are the record of what an approver said an invoice was
_for_. A hard delete is therefore either impossible (the row is linked) or destructive of
registry history (it is not linked _yet_).

So `is_active=false` is the removal, exactly as `listSiteEquipment()` already assumes — it
filters `is_active: true` for the approver's picker, verified in
`src/lib/ap/equipment.ts`. Two consequences worth stating explicitly:

- The `[id]` route exposes **no `DELETE` handler at all**. `/api/admin/users/[id]` ships
  `DELETE` as a deactivate alias; equipment deliberately does not, so no client can even
  form a request that _looks_ like a delete. A test asserts the export is absent.
- Deactivation is never blocked by linkage. Removing a scrapped asset from the picker must
  always work; it is the row's _deletion_ that is forbidden, not its retirement.

Deactivate/reactivate audit as `soft_delete` / `restore`. There is no `deleted_at` column
here — `is_active=false` **is** the soft delete — and reusing the users vocabulary keeps the
existing audit-viewer labels accurate for this table.

### D2 — Search, not pagination.

554 rows needs one or the other. Chose **server-side search on `display_name`** (`?q=`,
case-insensitive substring), with no page window and no silent result cap.

- **It matches the actual task.** Every maintenance action starts from a unit number the
  admin is holding on a work order: "EQ43 was re-categorised", "F62 is scrapped". Search is
  a few keystrokes. Pagination makes the same task a hunt through ~20 pages.
- **The filters already cut the set.** Site (413 / 141) × status (521 / 33) × category
  narrows it before search does.
- **Pagination interacts badly with the Amendment 1 round-trip contract.** A `?page=` is
  view state that goes _stale on mutation_: deactivating a row under the default
  `status=active` filter removes it from the result set and shifts every later row up a
  page, so the admin saves and returns to a page that no longer holds what they were
  working on. `?q=` has no such failure mode — it is stable under mutation.
- **The payload is not the problem it looks like.** The unfiltered worst case is 554 rows of
  five short cells on an admin-only desktop surface. Cheap, and the row count is displayed
  so the admin always knows the size of what they are looking at.

If the registry ever grows past a few thousand rows this should be revisited — the honest
threshold is when an unfiltered render stops being instant, not a row count decided today.

### D3 — `(site_id, display_name)` becomes a real DB constraint.

`scripts/seed-equipment-master.mjs` keys its idempotency on exactly this pair: a re-run
against a refreshed workbook does `findFirst({ site_id, display_name })` and updates in
place, or inserts when absent. That contract was a **convention held by one script**. The
moment a human can create rows, a duplicate name within a site would make the next seed
re-run insert a third copy instead of updating — and would put two indistinguishable options
in front of an approver whose pick becomes financial evidence.

So: a unique index (`prisma/migrations/20260813_adr0063_equipment_display_name_unique`) plus
`@@unique([site_id, display_name])` in the schema, and an app-level pre-check that returns a
readable 409 instead of a raw P2002. The app check alone would not do — check-then-act races
under concurrent creates — so the index is the guarantee and the app catches its P2002 as
the same `name_taken` reason.

Three sub-decisions:

- **Unconditional, not partial.** The index deliberately covers `is_active=false` rows.
  Equipment has no `deleted_at`; deactivated rows are retained precisely so historical
  `ap_equipment_links` resolve. `WHERE is_active` would let an admin create a live duplicate
  of a deactivated asset — the exact ambiguity the seed key exists to prevent. The right
  action for a returning asset is to **reactivate** it, and the `name_taken` copy says so.
- **Names are normalised on write** (trim + collapse internal whitespace runs). Without
  this, `"EQ43  — Shear"` and `"EQ43 — Shear"` are distinct to Postgres and identical to a
  human, and the constraint buys nothing.
- **Verified safe before writing the migration.** Production (`svdp-dev` / `dr3_vision`,
  2026-07-28) holds 554 rows with **zero** duplicate `(site_id, display_name)` groups. This
  matters more than usual: the deploy path runs `prisma migrate deploy` at container start,
  so a constraint violation here would crash-loop the app rather than fail a build step.

### D4 — `site_id` stays editable, including on assets an approval cites.

**This decision was made, and reversed, on the same day. Both halves are recorded here on
purpose** — a future reader who finds a freely-mutable `site_id` on rows cited by financial
approvals should find the reasoning rather than a silence.

**What was originally decided.** Transferring an asset between Eugene and Woodland is a real
operation, so the edit form allowed it — _unless_ `ap_equipment_links` already referenced the
row, in which case the server refused with `site_locked_by_links` (409) and the select was
disabled. The argument: `assertEquipmentForSite()` validated the site at decide time and
never re-checked, so moving a cited asset would leave an approved decision permanently
referencing equipment its approver's **site-filtered** picker could never have offered — a
silent, invisible inconsistency in the evidence trail. Hard rule #2's separation was read as
applying to the record of what was approved, not only to live queries.

**Why it was dropped.** [ADR-0046 Amendment 7](0046-vendor-invoice-approval-mailbox.md) —
merged the same day (PR #181), from an
operator directive explicitly overriding Amendment 5 — made the AP equipment selector
**fleet-wide**. `listSiteEquipment()` dropped its site predicate, and `assertEquipmentForSite()`
dropped its `siteId` parameter entirely so picker and validator stay in agreement. Two
consequences kill the lock:

1. **The premise is gone.** Every approver now sees every ACTIVE asset regardless of
   `site_id`. There is no longer any asset an approver "could never have been offered", so a
   transfer cannot create the inconsistency the lock was defending against. `site_id` is not
   read by the AP path at all any more.
2. **The lock was actively harmful.** Amendment 7's own reasoning is that site attribution
   here is _untrustworthy_ — the ADR-0062 seed mapped 554 rows by jurisdiction as a fallback
   because the source workbook has no `DR3 Eugene` facility (C-28). Correcting those coarse
   assignments is a core reason this screen exists. The lock would have made the **most-cited
   assets** — the ones actually in use, and therefore the ones whose site data matters most —
   precisely the ones nobody could fix. That is backwards.

**What now constrains a move:** only `(site_id, display_name)` uniqueness (D3), so a transfer
into a site that already carries that name is refused as `name_taken`. Every edit — rename,
re-categorise, or transfer — is captured `before`/`after` in the audit log, and that snapshot,
not an immutable column, is what preserves the state as it stood at approval time. The AP
citation count is still surfaced on the list and the edit page, now purely as context so an
admin can see they are touching an asset financial approvals point at.

**Renames were always allowed** on cited rows, for the same reason: refusing them would make
a typo permanent.

### D4a — `is_active` is now the only thing scoping the approver's picker.

A direct consequence of Amendment 7 that raises the stakes on a path this ADR already owned.
The picker used to be narrowed by site **and** active-status; it is now narrowed by
`is_active: true` and nothing else. So the deactivate/reactivate pair in this module is the
**sole** mechanism that adds or removes an option from a financial-approval surface, and it
acts on **both sites at once**.

Nothing about the implementation changed — it was already audited in-transaction and already
confirm-gated — but the copy and the tests now say so explicitly: the confirm dialog and the
edit-page helper state that both sites lose the option, and `equipment.test.ts` asserts the
removal against `listSiteEquipment()`'s exact post-Amendment-7 predicate rather than against a
generic "is_active flipped" check, so a future narrowing of that predicate breaks the test.

### D5 — A sibling `list-url` module, not a generalised one.

ADR-0017 Amendment 1 made the query-string round trip normative and named
`src/app/admin/users/list-url.ts` as the single serializer **for that list**. This surface
gets `src/app/admin/equipment/list-url.ts` with structurally identical function names and
the same whitelist semantics, over `?site=&category=&status=&q=`.

Deliberately duplicated rather than extracted. The param sets differ (`role` vs
`category` + `q`), and each surface's whitelist is meant to be its own closed set — a shared
generic would need a schema-descriptor argument that reads worse at both call sites than the
~90 duplicated lines cost. The users module also landed today (PR #176) as the fix for a live
site-separation footgun; refactoring it in the same week trades a real regression risk for a
cosmetic win. Names are kept parallel so a later extraction is mechanical.

The equipment surface is **born with** both halves of the Amendment 1 contract rather than
retrofitted with them: create/edit carry the filters back on save, cancel and the header
back-link, and the create form's site select seeds from `?site=` instead of `sites[0]`
(which, with `orderBy: { name: 'asc' }`, is always DR3 Eugene — creating from a
Woodland-scoped list would otherwise register the asset in Eugene and surface it in the wrong
site's approver picker).

## Non-decisions, recorded so they are not re-litigated

- **No `notifyStaff()` / no `rollout_surfaces` row.** ADR-0047's gate governs staff-facing
  **output** — mail, notifications, and dashboards linked from them. This screen sends
  nothing; it is an admin-only CRUD surface behind `role === 'admin'`. Verified rather than
  assumed: the module imports no mail path, and `no-direct-mail.test.ts` (the chokepoint
  test) stays green.
- **Admin surface stays English-only.** ADR-0017 fixed that for v1 and ADR-0061's CI
  key-parity gate covers `src/i18n/locales/*` (the `operator` and `manager` namespaces) —
  `src/app/admin/messages.ts` is not in its scope. New copy went into that one file, as
  ADR-0017 requires.
- **No `location` / `facility` column.** Still the right long-term model (ADR-0062 deferred
  it), still out of scope here, and still collides with hard rule #1 the moment a Stockton
  row renders. C-28 is unchanged by this ADR: the coarse jurisdiction mapping is now
  _editable by hand_, which is a mitigation, not a fix.

## Consequences

- **C-27 closes.** The registry is maintainable from the UI; the seed script reverts to what
  it should have been all along — a bulk-import path for a refreshed workbook, not the only
  write path.
- **The seed script's idempotency is now enforced rather than assumed.** A future re-run
  cannot silently duplicate, because the DB will not let it.
- **`link_count` is surfaced** on the list and the edit page, so an admin can see which
  assets are load-bearing for AP before touching them.
- **One new coupling:** `src/app/admin/equipment/labels.ts` maps `EquipmentCategory` →
  message key as a total `Record`, so adding a value to the Prisma enum now fails the build
  there instead of rendering a raw `terex` to an admin. That is intended.
- **KNOWN EXPOSURE — the uniqueness key is per-site, but the picker is now fleet-wide.**
  D3's constraint is `(site_id, display_name)`. Before ADR-0046 Amendment 7 that exactly
  matched what an approver could see, because the picker was site-scoped: within one site,
  no two options could share a label. Amendment 7 made the picker fleet-wide, so the
  constraint and the rendered option set no longer line up — **two sites can legitimately
  hold the same `display_name`, and both labels would appear side by side in one picker with
  nothing to tell them apart.** Verified against live prod on 2026-07-28: **zero** cross-site
  duplicate `display_name` values among active rows, so this is latent, not present.

  The constraint is deliberately **left per-site**. A global unique index would be the wrong
  fix: it would forbid two genuinely distinct assets at different facilities from sharing a
  unit number — a real-world situation the SVdP roster already contains (5 unit numbers
  repeat across the workbook, which is why the seed appends `(#n)` suffixes) — and it would
  break the ADR-0062 seed script's `(site_id, display_name)` idempotency key, which is the
  whole thing D3 exists to make real.

  So if duplicate labels ever surface in the approver's picker, the fix is **naming or
  grouping in the multi-select** — disambiguate the label, or group options by site/category
  in the picker UI — **not** a global unique index. Amendment 7 says the same about the
  picker growing unwieldy: "the fix is search/grouping in the multi-select, NOT reinstating a
  filter on untrustworthy site data."

## References

- CLAUDE.md hard rules #2 (site separation), #6 (append-only audit), #10 (`onClick`, not `<form>`)
- ADR-0017 + Amendment 1 — the admin-surface pattern and the list round-trip contract
- ADR-0062 — the seed, its site mapping, and the `(site_id, display_name)` key
- ADR-0046 Amendment 5 — `ap_equipment_links`, the Approve-panel multi-select
- **ADR-0046 Amendment 7** — made the selector + validator fleet-wide; reversed D4's lock,
  raised the weight of `is_active` (D4a), and created the per-site-uniqueness exposure above
- `docs/OPEN-ITEMS.md` C-27 (closed here), C-28 (unchanged)
