# Build spec — iPad floor inventory-validation surfaces (ADR-0060)

**Date:** 2026-07-25
**Author:** Terry (research + architecture)
**Builder:** aegis (implement in one pass; DESIGN here is complete and unambiguous)
**ADR:** `docs/adr/0060-ipad-floor-inventory-validation-surfaces.md`
**Status:** Built 2026-07-25 (aegis) — on branch `feat/adr-0060-ipad-floor-surfaces`, PR pending review + merge + prod deploy by Bill. Ready for testing is the acceptance bar (met on the branch; verify on the live URL after deploy).
**Depends on:** ADR-0037 (running balance / `inbound_loads` / `paper_bulk`), ADR-0047 (rollout gate),
ADR-0058 (processed bridge + floor-probe), ADR-0059 (inbound bridge + the confirmation contract this
surface completes), `#166` (manager `paper_bulk` path).

---

## §0 — Why this exists (the "I thought it was done" reconciliation)

Bill's understanding was that the iPad floor surfaces were complete. Ground truth (verified against the
live prod DB on CHAD-HQ and the `main` tree at commit `ad93b61`, 2026-07-25):

**What IS built and shipped (correctly credited):**

- The full operator iPad **shell + auth**: site picker → name picker → 4-digit PIN keypad
  (`/operator`, `/operator/[site]`, `/operator/[site]/[userId]`), Auth.js Credentials `pin` provider,
  green high-contrast field palette, i18n (en/es/ur), idle-timeout tuned for operators.
- A full **per-load DOCK-CAPTURE workflow** (`/operator/[site]/queue` + `/operator/[site]/load/[id]`):
  start from an `ExpectedLoad` → BOL photo → weight → door-open (timer) → count stacks → finish → submit
  / reject, all guarded by the `load-service` state machine. This writes per-load `inbound_loads`
  (`load_source_type='b2b_haul'`).
- The **Eugene go-live iPad polish**: viewport fixes, pinch-zoom, PDF preview, 8pm report timing.
- The **ADR-0059 backend confirmation CONTRACT**: `upsertBulkInboundDay` (`src/lib/loads/bulk-inbound.ts`)
  performs the delete-then-write that retires a provisional `mymrc_haul` row and installs a confirmed
  aggregate — in one audited transaction. The MyMRC inbound bridge is live and has written **610
  provisional `mymrc_haul` rows** (Woodland, 2024-03-01 → 2026-07-21).

**What is NOT built — the gap Bill actually hit:**

There is **no iPad floor surface** that lets floor staff confirm/log the day's inbound haul counts,
confirm/log processed counts, or confirm on-hand inventory. The ADR-0059 confirmation contract exists
only as a backend function reachable **from the manager DESKTOP** (`/api/manager/[site]/bulk-inbound`).
The provisional→confirmed lifecycle Bill described ("when the iPads come online we verify that data for
confirmation day-to-day") has **zero floor UI and zero floor endpoint**.

**Prod evidence of the gap:**

| Signal | Value | Meaning |
|---|---|---|
| `inbound_loads` by source | 610 `mymrc_haul`; **0 `paper_bulk`; 0 `b2b_haul`** | 100% of inbound is unconfirmed provisional. No confirmation — floor or manager — has ever happened. No per-load dock capture has ever produced a row. |
| operator API routes | **none exist** (`src/app/api/operator/**` absent) | The floor has no write endpoint of any kind. |
| operators provisioned | 2 (both test users: "Test Operator"/woodland, "Nehemiah Niles"/eugene) | Floor is not yet staffed with real operators. |
| Woodland physical anchor | 2026-07-22 = 2,483 (prior 2026-06-30 = 3,977) | Live floor keyed to a manager desktop count. |
| Eugene physical anchor | **none** | Eugene on-hand cannot be computed — no floor count path to establish one. |
| Eugene `mymrc_haul` rows | **0** (ADR-0057 C-21 not built) | Eugene inbound leg empty; floor must be able to ENTER, not only confirm. |

**Conclusion:** the iPad has a per-load dock workflow (built, unused, 0 rows) but not the *day-to-day
inventory-validation layer* Bill means. This buildout adds that layer: confirm inbound, confirm/log
processed, confirm on-hand — the floor's daily validation loop — on top of the ADR-0059 contract.

---

## §1 — Scope (IN / OUT), grounded in ADR-0059 D4 and the running balance

**IN scope — floor role (operator PIN), iPad/tablet viewport, green palette:**

1. **F-1 Floor home / daily validation hub** — `/operator/[site]/today`. The shift landing: cards for
   the three validation tasks + a link to the existing per-load Queue.
2. **F-2 Inbound haul-count confirmation** — `/operator/[site]/inbound`. THE piece. Confirm (accept) or
   correct the day's provisional MyMRC inbound; on Eugene (no provisional) ENTER the day's received count
   from scratch. Completes the ADR-0059 D4 contract.
3. **F-3 On-hand count (physical inventory validation)** — `/operator/[site]/count`. Enter the floor's
   physical count; it becomes the new anchor via the existing `reconcilePhysicalCount` money path.
   Highest value on Eugene (establishes its first anchor).
4. **F-4 Processed / stripped count confirmation** — `/operator/[site]/processed`. Confirm/enter the
   day's processed (stripped) units. **P2 — flagged decision (§7-A2)**: processed already has a MyMRC
   bridge + manager Option-B entry + a separate bonus-module capture, so floor ownership here is a
   choice, not a forced gap.

**OUT of scope (do not build on iPad):**

- **AP / vendor-invoice approval** — DESKTOP-only, managers/admins via Entra SSO (`/dashboard/ops/ap`,
  `/api/ops/ap/**`). The iPad is PIN operators; AP must never appear there.
- Manager desktop loads-inventory CRUD, billing, COR, invoices, reconciliation upload, exports.
- **Close / lock authority** — stays admin (Bill closes and locks days). The floor CONFIRMS; it never
  closes or locks. `upsertProcessedUnits` already refuses closed days (409) — that boundary holds.
- Bonus / production entry — separate module (kept distinct even where it overlaps processed counts).

**Coexistence, not replacement:** the per-load dock-capture flow (F-existing) stays reachable from F-1.
It is the high-fidelity truck-by-truck path (writes `b2b_haul` rows) for when `ExpectedLoad`s are synced
and staffing supports per-truck capture. The new surfaces are the day-aggregate validation layer. See the
double-count money-safety guard in §4-C — the two grains must not both count the same day.

---

## §2 — Auth + gating (shared by every floor surface)

**New helper** `requireOperatorForSite(siteCode)` in `src/lib/auth-helpers.ts`, mirroring
`requireManagerForSite` and the canonical inline pattern already used in
`src/app/operator/[site]/actions.ts` (`ctx()`):

- `const session = await auth();` → 401 `Response` if no `session.user.id`.
- `session.user.role !== 'operator'` → 403. (Operators only. Managers/admins use the desktop surfaces;
  they are NOT granted the floor write path — keeps the audit actor unambiguous.)
- Resolve site by `code`; 404 if unknown.
- `session.user.primary_site_id !== site.id` → 403. Operators are always single-site (`all_sites:false`,
  ADR-0030), so no all-sites branch.
- Returns `{ siteId, siteCode, siteName, userId }`.

Add `checkOperatorForSite` (discriminated-result variant) for the page-render path, matching
`checkManagerForSite`, so pages can redirect to `/operator/[site]` on failure.

**Rollout gate:** floor surfaces respect the existing per-site `loads_inventory` UI surface
(`isUiSurfaceLive(UI_SURFACE.LOADS_INVENTORY, siteId)`, ADR-0047), so Woodland and Eugene flip
independently. Until a site's surface is `live`, the floor cards render a "not yet activated" state.
(For immediate testing, flip Woodland `live`; Eugene stays gated until C-21 provides its data — except
F-3 on-hand count, which is valuable pre-C-21; see §7-A3.)

**Session hygiene:** every floor write re-derives operator + site from the session server-side — never
trust a client-supplied `siteId`/`userId` (same rule as `actions.ts`).

---

## §3 — Surfaces (routes, components, behavior)

All pages: `export const dynamic = 'force-dynamic'`, green palette (`bg-dr3-green-deep` /
`text-dr3-cream`), i18n via the operator dictionary (add a `floor.*` namespace to
`src/i18n/locales/{en,es,ur}/operator.json`), tap targets ≥ 44px, no hover-only or drag interactions,
number entry via a large on-screen stepper/keypad (operators work outdoors, often gloved).

### F-1 — Floor home / daily hub — `/operator/[site]/today`
- **Files:** `src/app/operator/[site]/today/page.tsx` (server), `today-client.tsx` (cards).
- **Reads:** `onHand(siteId, now)` for a headline on-hand tile (program / non-program / total);
  count of unconfirmed `mymrc_haul` days in the recent window (badge on the Inbound card).
- **Cards:** (1) Confirm inbound → F-2, (2) On-hand count → F-3, (3) Processed count → F-4 [if enabled],
  (4) Per-load queue → existing `/operator/[site]/queue`.
- Header: site name, signed-in operator, sign-out (reuse `SignOutButton`).

### F-2 — Inbound haul-count confirmation — `/operator/[site]/inbound`
- **Files:** `src/app/operator/[site]/inbound/page.tsx` (server), `inbound-client.tsx`.
- **Reads (GET `/api/operator/[site]/inbound`):** recent aggregate inbound days (last ~14) with, per day:
  `arrived_at` (Pacific day), `total_units`, `program_unit_count`, `non_program_unit_count`,
  `load_source_type` (`mymrc_haul`=provisional, `ipad_floor`=floor-confirmed, `paper_bulk`=office), and a
  `hasPerLoadCapture` flag (§4-C). Today pinned at top.
- **Actions per day:**
  - **Confirm** (provisional exists, counts look right): POST confirm with the provisional's counts →
    writes floor-confirmed row, retires the provisional.
  - **Correct** (provisional exists, counts wrong): edit program / non-program (total auto-derives;
    split invariant enforced) → POST confirm with corrected counts.
  - **Enter** (no provisional — Eugene, or a missed day): enter counts fresh → same POST.
- Confirmed days show a "Floor-confirmed by you · <time PT>" chip and remain editable (re-confirm is
  idempotent). A day owned by `paper_bulk` (office) is read-only on the floor with an "office-entered"
  chip (precedence, §7-A1).

### F-3 — On-hand count — `/operator/[site]/count`
- **Files:** `src/app/operator/[site]/count/page.tsx` (server), `count-client.tsx`.
- **Reads:** `onHand(siteId, now)` — show the COMPUTED on-hand prominently so the operator sees what the
  system expects before entering the physical count.
- **Entry:** `units_indoor` and `units_in_processing` (outdoor is not tracked — ADR-0037 addendum). Show
  the derived total live. Optional program/non-program split (defaults to `legacy`/unsplit if omitted;
  `measured` requires the split to sum — same rule as the manager path).
- **Submit (POST `/api/operator/[site]/count`):** `reconcilePhysicalCount({ actorUserId: operator })`.
  Show the resulting `reconciled_delta` (physical − computed) with a plain-language "N units more/fewer
  than expected" so the operator understands the drift. Delta is recorded, never silently absorbed.

### F-4 — Processed / stripped count confirmation — `/operator/[site]/processed` (P2, see §7-A2)
- **Files:** `src/app/operator/[site]/processed/page.tsx` (server), `processed-client.tsx`.
- **Reads:** today's `processed_units_daily` row (may already exist from the ADR-0058 bridge or manager
  Option-B entry) with `stripped_program` / `stripped_non_program`; recent days.
- **Entry:** confirm/correct `strippedProgram` + `strippedNonProgram` only. Bonus-adjacent fields
  (employees, processors, pocketcoil, material ticket, saved units) stay on the manager surface — the
  floor confirms the count, not the payroll inputs.
- **Submit (POST `/api/operator/[site]/processed/confirm`):** reuse `upsertProcessedUnits` with
  `actorUserId=operator`; it already refuses closed days (409) and is idempotent per (site, day).

---

## §4 — API + service contracts (the money path)

### F-2 service — `src/lib/loads/floor-inbound.ts` (NEW)

`confirmFloorInboundDay(args: { siteId, inboundDate: Date, totalUnits, programUnits, nonProgramUnits,
actorUserId, correctionNote?: string | null }): Promise<BulkInboundView>`

- Reuse `assertSplit` + `inboundArrivedAt` (Pacific-midnight day key) from `bulk-inbound.ts` — export
  them or move to a shared `inbound-aggregate.ts` so both services share one definition (do NOT
  re-implement the Pacific-midnight instant — it must byte-match what `onHand` windows on).
- New provenance constant `FLOOR_SOURCE_TYPE = 'ipad_floor'` (see migration §5 and decision §7-A1).
- In ONE `prisma.$transaction`:
  1. **Money-safety guard (§4-C):** if any *non-aggregate* verified inbound row exists for
     (site, that Pacific day) — i.e. a `b2b_haul` / per-load `inbound_loads` row with
     `status IN VERIFIED_INBOUND_STATUSES` and `arrived_at` in the day — **refuse** with a typed 409
     (`FloorInboundConflictError`, "per-load captures already exist for this day; confirm on the
     per-load queue"). Prevents aggregate + per-load double-count in `onHand`.
  2. Delete any `mymrc_haul` row for (site, day); audit the delete (`before` = its counts).
  3. Delete any `paper_bulk` row for (site, day) **only on the correct/enter path where the operator is
     overriding office** — DEFAULT: leave `paper_bulk` untouched and refuse (see §7-A1 precedence).
     Recommended: floor does NOT clobber office; if `paper_bulk` owns the day, refuse (409, "office-entered;
     ask a manager to amend"). This keeps precedence explicit and matches the read-only chip in F-2.
  4. Upsert the `ipad_floor` aggregate: `status='verified'`, `count_mode='total'`, absolute SET of
     `total_units`/`program_unit_count`/`non_program_unit_count`, `slip_number`=correctionNote (or null),
     `submitted_by_id`=operator, `arrived_at`=Pacific-midnight day. Idempotent per (site, day) via the
     widened partial unique index; re-confirm UPDATEs in place (absolute SET → double-count-proof).
  5. Audit the insert/update (`actor_user_id`=operator, before/after counts) in the same tx (hard rule #6).

**Route:** `src/app/api/operator/[site]/inbound/route.ts`
- `GET` — `requireOperatorForSite` → list recent aggregate days + `hasPerLoadCapture` per day.
- `POST` — `requireOperatorForSite` → Zod-validate `{ inboundDate: /^\d{4}-\d{2}-\d{2}$/, totalUnits int>0,
  programUnits int≥0, nonProgramUnits int≥0, correctionNote?: string≤120 }` → `confirmFloorInboundDay`.
  Map `FloorInboundConflictError`→409, split mismatch→422 via a floor error helper mirroring
  `loadsErrorResponse`.
- `runtime='nodejs'`, `dynamic='force-dynamic'`.

### F-3 route — `src/app/api/operator/[site]/count/route.ts`
- `POST` — `requireOperatorForSite` → Zod `{ unitsIndoor?: int≥0, unitsInProcessing?: int≥0,
  programUnits?: int≥0|null, nonProgramUnits?: int≥0|null, poolAttribution?: 'measured'|'legacy' }` →
  `reconcilePhysicalCount({ siteId, countedAt: Pacific-midnight of today, physical, programUnits,
  nonProgramUnits, poolAttribution, actorUserId: operator })`. Return `{ computedTotal, physicalTotal,
  reconciledDelta }`. `countedAt` uses `pacificMidnightInstantOfDayISO(dayISO(now))` so the new anchor
  stamps at Pacific-midnight (the convention `anchorFlowBounds` requires — never UTC midnight).
- Reuse the existing `PoolSplitMismatchError`→422 mapping.

### F-4 route — `src/app/api/operator/[site]/processed/route.ts` (P2)
- `POST` — `requireOperatorForSite` → Zod `{ productionDate, strippedProgram≥0, strippedNonProgram≥0,
  notes?≤2000 }` → `upsertProcessedUnits({ ..., actorUserId: operator })`. Closed-day 409 propagates.

### §4-C — Aggregate vs per-load double-count (money-safety finding)

`onHand` sums **every** verified `inbound_loads` row for the window regardless of `load_source_type`. The
partial unique index prevents two *aggregate* rows per day, but does **not** prevent an aggregate row
(`mymrc_haul`/`paper_bulk`/`ipad_floor`) from coexisting with per-load `b2b_haul` rows on the same day —
that would double-count. This is latent-safe today (0 `b2b_haul` rows in prod) but becomes live the moment
the floor uses both grains. The F-2 confirm guard (§4-A step 1) closes it on the write path this buildout
adds. **Flag:** the ADR-0059 bridge itself has the same latent gap (it will write a `mymrc_haul` aggregate
for a day that has per-load rows); recommend a follow-up guard in `inbound-bridge.ts` (skip days with
verified per-load rows). Out of scope for the UI buildout; documented in ADR-0060 Consequences.

---

## §5 — Migration

`prisma/migrations/20260812_adr0060_ipad_floor_inbound_source/migration.sql` (monotonic ordinal after
`20260810`; additive; clean-replay; idempotent):

1. `ALTER TYPE "LoadSourceType" ADD VALUE IF NOT EXISTS 'ipad_floor';` (must be its own statement /
   committed before use — Postgres enum-add cannot run in the same tx as its use; Prisma handles this as a
   standalone migration).
2. Widen the partial unique index to include the new value:
   `DROP INDEX IF EXISTS "<paper_bulk_mymrc_haul_unique_idx name from 20260810>";`
   `CREATE UNIQUE INDEX ... ON "inbound_loads" (site_id, arrived_at) WHERE load_source_type IN
   ('paper_bulk','mymrc_haul','ipad_floor');`
   (Read the exact index name from `20260810_adr0059_mymrc_haul_inbound_source/migration.sql` and reuse it.)
3. Update the `@@index` comment block on `InboundLoad` in `schema.prisma` to note the three-value predicate
   (Prisma has no partial-index syntax; the migration is authoritative, the `@@index` mirrors lookup shape).

**If Bill chooses the zero-migration fallback (§7-A1, reuse `paper_bulk`):** skip this migration entirely;
`confirmFloorInboundDay` calls `upsertBulkInboundDay` verbatim (actor=operator) and floor/office share the
`paper_bulk` tier.

---

## §6 — Test plan (unit + the iPad-viewport visual gate)

**Unit — `src/lib/loads/floor-inbound.test.ts`:**
- Split invariant enforced (program+nonProgram==total, else 422). Reuses the `bulk-inbound` invariant.
- Confirm retires the `mymrc_haul` provisional (delete audited) and installs exactly ONE `ipad_floor` row.
- Idempotent re-confirm UPDATEs in place (absolute SET; no second row; no double-count).
- Per-load coexistence guard: a `b2b_haul` verified row for the day → 409, no write, no audit.
- Precedence: a `paper_bulk` row owns the day → floor confirm refuses 409 (or clobbers — per §7-A1 choice);
  assert the chosen behavior.
- Eugene enter-from-scratch (no provisional) writes a fresh `ipad_floor` row.
- Every write path emits an `audit_log` row with `actor_user_id`=operator in the same tx.

**Unit — route auth:** `requireOperatorForSite` → 401 (no session), 403 (role≠operator), 403 (wrong site),
200 (operator at own site). Reuse the existing auth-helper test patterns.

**Unit — F-3/F-4 reuse:** operator-actor path through `reconcilePhysicalCount` / `upsertProcessedUnits`
(closed-day 409, pool-split 422) — extend existing service tests with the operator actor.

**Playwright iPad-viewport visual verification — HARD ACCEPTANCE GATE (per the fleet UI visual-verification
gate):** capture and review BY EYE, per surface (F-1..F-4), at:
- iPad Mini 768×1024, iPad 10th 820×1180, iPad Pro 12.9 1024×1366 — **portrait AND landscape**.
Assert by eye: tap targets ≥44px, green outdoor-legible palette, no horizontal scroll, number entry works
without a hardware keyboard, no desktop-only interaction. Screenshots go in the PR. "Tests pass / no
overflow" alone is NOT done — eyes on the screenshots, and then verify on the LIVE URL after deploy.
- **Verify against the CONTAINER, not git HEAD** (`docker exec dr3-vision-app` — CHAD deployer can build
  from a pre-pull tree; confirm the running container has the new routes before declaring ready).

---

## §7 — Flagged decisions for Bill (default = the recommended option; all resolvable, none block build)

- **A1 — Floor-confirmed provenance tier.** *Recommended:* new `load_source_type='ipad_floor'` +
  widened index, precedence `ipad_floor > paper_bulk > mymrc_haul` (honors ADR-0059 D4 literally; clean
  report/audit labeling; trivial additive migration mirroring ADR-0059's own). *Fallback (zero-migration):*
  floor writes `paper_bulk` via the existing `upsertBulkInboundDay` — simplest, but collapses D4's
  three-tier precedence to two and loses source-type-level floor-vs-office distinction (still visible in
  `audit_log`). **Sub-question:** should a floor confirm be allowed to OVERRIDE an office `paper_bulk` day,
  or refuse it? Recommended: **refuse** (office amends via manager) — matches the read-only chip in F-2.
- **A2 — Does the floor own processed-count entry (F-4)?** *Recommended:* build it as a confirm-only
  surface (P2, after F-2/F-3) since processed already has a MyMRC bridge + manager Option-B + bonus-module
  capture. If Bill wants processed to stay manager-entered, drop F-4 and its route; F-1 hides the card.
- **A3 — Eugene rollout.** Eugene has no `mymrc_haul` provisional (C-21 not built) and no physical anchor.
  F-2 supports enter-from-scratch and F-3 establishes the first anchor, so Eugene benefits from F-3 (and
  F-2 manual entry) even before C-21. *Recommended:* flip Woodland `loads_inventory` live for testing now;
  enable Eugene's F-3 (count) ahead of its F-2 data. Confirm whether Eugene floor should manually enter
  inbound pre-C-21 or wait.

---

## §8 — Build sequence (one pass, so aegis can ship the set)

1. Migration `20260812` (if A1=ipad_floor) → `prisma generate`.
2. `requireOperatorForSite` / `checkOperatorForSite` in `auth-helpers.ts` (+ tests).
3. Shared aggregate helpers (export/move `assertSplit` + `inboundArrivedAt`); `floor-inbound.ts` service
   (+ tests) with the §4-C guard.
4. Floor API routes: `/api/operator/[site]/inbound` (GET+POST), `/count` (POST), `/processed` (POST, P2).
5. Floor pages F-1..F-4 + `floor.*` i18n keys (en/es/ur).
6. Report tweak (P3): ADR-0059 D6 provisional flag already auto-drops when a day becomes `ipad_floor`;
   optionally label floor-confirmed days positively in `renderEodInventoryHtml`.
7. Unit suite green → deploy to CHAD → Playwright iPad matrix reviewed by eye on the LIVE URL → verify the
   container has the routes (`docker exec`) → ready for testing.
8. Docs: CHANGELOG moved from Planned→Added on ship; ADR-0060 stays Accepted; update this plan's status.
