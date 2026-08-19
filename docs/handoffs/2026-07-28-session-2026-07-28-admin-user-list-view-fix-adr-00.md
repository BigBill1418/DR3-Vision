# Session handoff — 2026-07-28

Two pieces of work, both shipped to production on svdp-dev. Written for whoever
picks this up next.

---

## 1. Admin user list lost its view on save — SHIPPED (PR #176, `c148411`)

### Reported

> "when you make a new operator user for woodland and you click save it goes back
> to the list of ALL users. it should stay where you were just working rather than
> switch that view"

### What was actually wrong — two defects, not one

**Defect 1 (the reported one).** `UserCreateForm.tsx:95` pushed a hard-coded
`'/admin/users'` on save (and `:288` on cancel). The list's filters ARE the URL
(`?site=&role=&status=`) — ADR-0017 specified URL-driven filters and the list page
even comments *"the URL IS the state"* — but the create/edit round trip never
carried them. A bare `/admin/users` resolves to all-sites/all-roles.

**Defect 2 (found while fixing 1, and the more consequential one).**
`UserCreateForm.tsx:30` seeded the site select from `sites[0]`. Sites are fetched
`orderBy: { name: 'asc' }`, and the live rows are `DR3 Eugene` / `DR3 Woodland` —
so **`sites[0]` is always Eugene**. Filtering to Woodland → *+ Add user* → save
created a **Eugene** operator unless the admin noticed and flipped the select.
That crosses the Eugene/Woodland separation line (hard rule #2): wrong
name-picker, and the per-site PIN-uniqueness check (`admin-users.ts` `setPin`)
runs against the wrong peer set.

It also would have made Defect 1's fix *look* broken — a Eugene-defaulted user is
invisible in the `?site=woodland` list you now correctly return to. They had to be
fixed together.

**No bad data resulted.** Audited every row in prod: no wrong-site user exists.
The three Woodland operators created 2026-07-28 (10:51/10:54/10:55 PT) all landed
on `woodland` — Bill had been flipping the dropdown by hand. Footgun closed before
it bit.

### The change

New `src/app/admin/users/list-url.ts` is the single parser + serializer for the
list's view state, threaded through list → create → edit. Params are
**whitelisted** to `site|role|status` so nothing unexpected rides into a
`router.push`.

**Not a scoping leak:** `/admin/users` is gated by `requireAdmin()` (admin
*powers*, not the `all_sites` *reach* check), so the only viewer of the all-users
list was already a global-reach admin. Defect 1 is UX; Defect 2 had the
data-correctness dimension.

Row actions (deactivate/reactivate) and edit **save** were already correct — they
use `router.refresh()` and never navigate.

### Verification

`npm run typecheck` 0 · `npm run build` 0 (all three `/admin/users*` routes
compile) · 19 new tests (`list-url.test.ts` 11, `new/UserCreateForm.test.tsx` 8) ·
CI 4/4 green · deployed and confirmed by provenance (box HEAD `c148411` → image
built from it → container running that exact image ID, started 19:25:49Z).

---

## 2. Equipment master seeded — the AP picker had nothing in it — SHIPPED (ADR-0062)

### The finding

`equipment` backs the AP Approve panel's equipment multi-select (ADR-0046 Am. 5).
In production it was **EMPTY**. All 12 `ap_equipment_links` rows written since AP
go-live are `is_not_equipment_related=true` — not a judgement about those
invoices, but because **approvers had nothing to pick**.

The AP code calls the registry "admin-managed" and `/api/ops/ap/equipment` is
read-only because "creation is admin-only" — but **no admin create surface was
ever built**. The only route under `/api/admin/equipment` is the Terex *history*
importer (`equipment_events`, a different table). There was no path, UI or API, to
populate the master.

### Source

`DR3 Machine List (2).xlsx`, file-drop `580024f8`, sha256 `4ffff995…` — the
SVdP-wide fleet register, **554 assets across 35 locations**.

### Live in prod

554 rows + 554 matching `audit_log` rows. eugene 413 / woodland 141;
521 active / 33 inactive. Categories: 459 vehicle, 39 forklift, 19 baler,
4 terex (shear machines incl. Woodland's `EQ74`), 33 other.

### ⚠ The site mapping is COARSE and known to be coarse

The workbook has **no `DR3 Eugene` facility** and only **21 `DR3 Woodland`** rows
out of 554. `equipment.site_id` FKs to `sites`, and only two site rows exist. Per
Bill's direction (*"you can load all of this in for all sites — just no better way
for now"*), rows were mapped by **jurisdiction**:

```
California      → woodland   (DR3 Woodland, DR3 Livermore, DR3 Stockton, OTR California)
everything else → eugene     (Oregon SVdP facilities, unqualified OTR fleet, blanks)
```

**Consequence:** Eugene's picker now contains the whole unqualified OTR fleet
(190 rows) and every SVdP Lane County facility; Woodland's contains Livermore and
Stockton assets. This is **not** a claim that Cleveland Warehouse is DR3 Eugene.

**OPEN QUESTION for the next session: which Eugene-Oregon facility IS the DR3
Eugene operation?** `135 N Cleveland - Cleveland Warehouse` (71 rows) is the
leading candidate — it has its own shear machine `EQ65` — but nothing in the
workbook or repo confirms it. Tracked as **C-28**. Re-running the seed script is
the refinement path.

### Stockton / hard rule #1

15 rows sit at the Stockton facility. The `equipment` model stores only
`display_name`, `category`, `site_id`, `is_active` — **there is no location
column** — so those assets load without "Stockton" entering any stored or rendered
string. No location text is persisted for any row. Satisfied by construction
rather than by dropping the assets.

### Normalization

- `display_name` = `"<Unit #> — <Make> <Type>"`; `(#n)` suffix for the 5 repeating
  unit numbers.
- 91 blank-Type rows resolved via Make (Great Dane/Fruehauf/Strick = trailers;
  Freightliner/Volvo = tractors; Ford/Toyota = light vehicles) and `F##` →
  forklift. **29 rows with no usable signal stay `other`** — honest unknown, not a
  guess.
- Scrapped / To Be Scrapped / Sold / Inactive / Out of Service / Transferred →
  `is_active=false`. Kept so historical AP links resolve; `listSiteEquipment`
  filters them out of the picker. "Pending Inspection" stays active.
- Ownership (Owned/Leased/Rented) **not persisted** — no column, not an
  approval-time attribute.

### Mechanism

`scripts/seed-equipment-master.mjs` — one-shot, idempotent (keyed on
`(site_id, display_name)`; updates category/is_active on drift, never duplicates,
never hard-deletes), audited (`actor_label='system:equipment-seed'`, source sha in
the `after` payload). **Re-run verified idempotent: 0 created, 554 unchanged.**

Parse and write are split (`--emit-json` / `--json`) because the deployed
standalone image ships `@prisma/client` but **not** `exceljs`.

---

## New open items logged this session

| # | Item |
| --- | --- |
| **C-26** | `CLAUDE.md`'s "done" bar requires `npx playwright test` green, but there is **no Playwright suite** in the repo — no `playwright.config.*`, zero `*.spec.ts`. `npm run e2e` maps to `playwright test` with nothing to run. The only Playwright is the MyMRC *scraper* (app code). Coverage is vitest-only. Fix the bullet or stand up a suite. |
| **C-27** | **No admin UI maintains the `equipment` master.** Every future fleet change needs another script run against prod until `/admin/equipment` ships (list + create + edit + activate/deactivate, site-scoped, audited, ADR-0017 pattern). |
| **C-28** | The equipment site mapping is coarse (above). Open question: which facility is DR3 Eugene? |
| **C-29** | **`bonus-cycle-e2e.test.ts` is FLAKY in the payroll-delivery path — and it guards real money.** ⚠ |

### C-29 deserves a look — do not dismiss it

The case *"(b) delivery FAILURE → stays signed, and t4 at 09:00 PT DOES fire the
real deadline-miss"* intermittently fails with `expected 'paid' to be 'signed'`.
The injected PDF failure (`Chromium crashed`) is logged correctly
(`[payroll-delivery] PDF generation failed; skipping mail`) — yet the period still
lands `paid`.

Observed in the husky pre-push gate on a commit containing **zero `src/`
changes** (1 failed / 567 passed); the same file then passed 3/3 in isolation and
the full `src/lib/bonus` suite 2/2. Separately it timed out at 5000ms under
full-suite CPU load earlier the same session.

Two candidates, both worth ruling out:
1. **Cross-test state leakage** — a prior test's period reaching `paid` bleeding in.
2. **A genuine race in `payroll-delivery`** where the state transition is not
   gated on PDF success.

**(2) would be a real payroll defect** — a period marked `paid` when the payroll
PDF never generated or sent. Prove the transition is ordered after delivery
success before calling this "just flaky".

---

## Environment notes (cost time this session)

- **`package-lock.json` in the dev clone is root-owned** (from a past `sudo npm`
  run) — `npm install` writes `node_modules` fine but fails writing the lockfile.
  Worth a `sudo chown bbarnard065`.
- Three declared deps were missing from the local `node_modules`
  (`@anthropic-ai/sdk`, `pdf-lib`, `pdf-parse`), which produced 14 phantom `tsc`
  errors and 4 test failures that look alarming and are purely local.
- The **stale clone** at `titanforge-workspaces/4/DR3-Vision` is pinned at
  2026-06-17. Work in `~/DR3-Vision`.
- The repo's TS config is stricter than most: `noUncheckedIndexedAccess` **and**
  `noPropertyAccessFromIndexSignature`. `fetchMock.mock.calls[0][1]` will not
  compile; type the parsed body rather than using `Record<string, unknown>`.
- Deploy is manual on **svdp-dev (10.99.0.2)**, not CHAD-HQ (repo CLAUDE.md still
  says CHAD-HQ — that line is wrong): `git pull` + `docker compose build app` +
  `up -d`. The image build takes several minutes.
- **ClaudeSync writes need arming first** — `create_handoff` refuses with
  `"disarmed"` until the break-glass window is opened on BOS-HQ
  (`docker exec $(docker ps -qf name=claudesync_api) curl -sS -X POST
  http://127.0.0.1:8000/api/write/arm -d '{"ttl": 21600}'`). Note `ssh bos-hq`
  does not resolve; use `bbarnard065@10.99.0.4`.

## Suggested next steps

1. Answer C-28 (which facility is DR3 Eugene) and re-run the seed to refine.
2. Investigate C-29 before it hides a payroll bug.
3. Build `/admin/equipment` (C-27) so the roster stops needing a script.
