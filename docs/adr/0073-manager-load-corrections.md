# ADR-0073 — manager corrections to submitted inbound loads

**Status:** proposed (2026-07-31) — design only, nothing implemented
**Builds on:** ADR-0072 (the tiered guardrail this borrows wholesale), ADR-0068 (the
dual-approval CHECK pattern), ADR-0037 D2/D6 (the verify gate + the ONE running
balance), ADR-0042 (COR immutability + supersede chain), ADR-0059/0060 (the aggregate
inbound grain), ADR-0032 (reporting-only adjustments — considered and rejected here)

---

## Context

### The trigger

Load **H-135881** (Costco-Innovel Benicia → DR3 Woodland, arrived 2026-07-31 09:46 PT)
was keyed as **40 units**. The correct figure is **95**. Bill asked for that specific
correction and for a general mechanism.

The correction was applied by hand at 18:35:50 UTC on 2026-07-31 (a direct DB `UPDATE`
plus a hand-written `audit_log` row citing this ADR as pending). That is the exact
failure mode this ADR exists to retire: the only available tool was a DBA-shaped one,
used by an actor with no product-level guardrail in front of them.

### What the code actually says (verified 2026-07-31 against `origin/main` @ `3eeb8a69`

### and the live Woodland database)

Several things assumed at the outset turned out to be false. They change the design, so
they are recorded here rather than in a footnote.

**1. `total_units` is not what moves inventory.** `onHand` sums
`program_unit_count` + `non_program_unit_count` only —
`src/lib/inventory/running-balance.ts:282-289`. `total_units` is never read by the
balance. Its only role is as the invariant target `assertProgramSplit` checks at the
verify transition (`src/lib/loads/verify-gate.ts:79-84`), and that invariant is never
re-checked afterwards. **Correcting `total_units` alone changes no number anywhere and
silently breaks the invariant.** The H-135881 row is in exactly that state right now:
`total_units = 95`, `program_unit_count = NULL`, `non_program_unit_count = NULL`.

**2. `total_units` is derived, not entered.** `finishUnload`
(`src/lib/load-service.ts:267-278`) sets it to `SUM(load_stacks.unit_count)`. Every
`b2b_haul` load in prod satisfies `total_units == Σ stacks` **except H-135881**, whose
stacks still sum to 40 (four multiplier stacks of 10, timestamped 17:46:29–17:46:39Z).
The hand-correction restated the header and left the evidence contradicting it. A
mechanism that only writes the header reproduces this divergence every time.

**3. Nothing bills inbound units.** Invoice lines derive from
`processed_units_daily.stripped_program` (`src/lib/invoices/generation-inputs.ts:124-128`)
and from consumer drop-offs. The one invoice query that touches `inboundLoad`
(`generation-inputs.ts:269-288`, freight/fuel) has an exhaustive `select` containing **no
unit or weight column** — freight is a per-haul lane rate, fuel is priced off
`source.canonical_mileage`. `src/lib/audit/comparators/c4-billing.ts:3` states it
plainly: _"The billing basis is PROCESSED program units, not inbound."_ An inbound load
contributes money by _existing_ with `transport_charged = true`, not by how many
mattresses were on it. **No invoice amount can change from this edit.**

**4. But something IS filed externally, and it is unprotected.** The **MRC Monthly
Invoice CSV (Article 10.4)** — `src/app/api/exports/mrc/route.ts:62-83` → `src/lib/exports.ts:226,232` —
emits `'Unit Count at Unload': load.total_units` and `'Recycler Weight': load.weight_lbs`.
It is a `force-dynamic` GET. **There is no snapshot, no version, no approval, and no
record of what was previously downloaded.** Re-pulling last month's file after a
correction silently yields a different file than the one already sent to MRC. Same for
`src/app/api/exports/svdp/route.ts:63`.

**5. The COR is safe from silent mutation, but a correction can brick it.**
`cor_certificates.inventory_units` is denormalized at draft generation
(`src/lib/cor/service.ts:100`) and every reader — view, list, PDF print page — reads the
stored column. A finalized Exhibit 5 (signed under penalty of perjury) never silently
changes. However `assertCorInventoryReconciles` (`src/lib/cor/service.ts:226-260`)
recomputes live and **throws 409** on drift, and `generateCorPdf` calls it as a gate
(`src/lib/cor/pdf.ts:112`). A correction inside a finalized cover month leaves a
certificate that is immutable, was correct when signed, and **can no longer render its
own PDF**. Recovery is `supersedeCor` → new draft → re-enter FT/PT → re-finalize.

**6. `inbound_loads` is the only loads/inventory model with no lock.**
`ConsumerDropoff`, `OutboundMaterial`, `LandfilledUnit`, `CollectionEvent` all carry
`locked_at`; `ProcessedUnitsDaily` carries `closed_at`. `InboundLoad` carries neither
(`prisma/schema.prisma:567-673`). There is no closed period, no locked month, and no
billed-window immutability anywhere on inbound.

**7. "There is no manager edit path" is true only for the per-load grain.** The
_aggregate_ grain already has two unguarded retroactive edit paths:
`upsertBulkInboundDay` (`src/lib/loads/bulk-inbound.ts:189`) and `confirmFloorInboundDay`
(`src/lib/loads/floor-inbound.ts:193`) both `update` `total_units` /
`program_unit_count` / `non_program_unit_count` on an existing **verified** row for an
**arbitrary past day**, with no date window, no anchor check, no COR check, and no lock.
`src/lib/mymrc/inbound-bridge.ts:237-244` does absolute-SET upserts on verified rows too.
So the honest statement is not "managers cannot correct loads" — it is **"managers can
already rewrite inventory history through the aggregate path with less friction than
ADR-0072 requires to change a single physical count."** That asymmetry is the larger
defect.

### Two live problems found while researching this

- **`2026-07-29` at Woodland holds both grains.** One `ipad_floor` **verified** aggregate
  (150 units) and two `b2b_haul` **submitted** per-load rows (106 units). The ADR-0060 D5
  double-count guard only refuses when per-load rows are **verified**
  (`floor-inbound.ts:146-152`). Verifying those two loads double-counts 106 units into
  `onHand`. Nine `b2b_haul` loads currently sit unverified; none has ever reached
  `verified`.
- **The amendment path `processed_units_daily` refuses into does not exist.**
  `src/lib/loads/processed-units.ts:178` throws _"corrections follow the amendment path,
  not in-place edits"_. There is no such route. `BonusReportingAdjustment` (ADR-0032) has
  **no write API at all** — all five prod rows were inserted by hand.

---

## Decision

### Shape: a tiered, approval-gated **restatement of the row**, with an append-only correction record — not a superseding adjustment layer

Three shapes were on the table.

**(a) A correction record that supersedes the original (ADR-0032 / COR-supersede style).**
**Rejected.** `running-balance.ts:1-6` states the entire purpose of D6: inventory is
_"ONE shared function… totals are a single query-backed computation, never two competing
spreadsheet sums"_ — written to kill the 06-22→23 divergence. An additive correction
layer means every consumer must learn a second term: `onHand`, `startBalance`
(`src/lib/audit/leg-fetchers.ts`), `inventory-close`, `cor/prefill`, the MRC CSV export,
and the C1/C5 audit comparators. Any one that doesn't diverges silently. ADR-0032 is
precedent _against_ this, not for it: it works because it is deliberately
**reporting-only** and never touches the money path. Note also that the house reserves
supersede chains for **issued artifacts** — `CorCertificate.supersedes_id`,
`Invoice.supersedes_id` — where the old version was physically handed to someone. An
inbound load is a **flow row**, not an issued artifact, and every sibling flow row
(dropoffs, outbound, landfilled, both inbound aggregates) is corrected by absolute SET +
audit row.

**(c) A straight audited edit inside a time window.** **Rejected.** Time is a proxy for
the wrong thing. H-135881 was same-day and safe; a same-day load already pulled into an
MRC CSV is not. A three-week-old load in a month with no finalized COR and no export is
safer than either. **Gate on what has been derived downstream, not on the clock.** A
window would also have permitted the two genuinely dangerous cases — a pre-anchor edit
and a finalized-COR-month edit — purely because they happened to be recent.

**(b) Edit-with-approval, tiered like the ADR-0072 anchor hold.** **Adopted.** The row
stays the single source of truth, so `onHand` and all six consumers keep working
unchanged and no second sum is introduced. The append-only obligation is met by a
first-class `inbound_load_corrections` record carrying before/after, actor, reason, and
the computed downstream impact — the original values stay readable without the balance
having to read them. And it reuses a pattern that shipped yesterday and that Bill has
already reasoned about.

### The tiers

Classification is computed **server-side from live state on every write**, exactly as
`classifyAnchorWrite` is (`anchor-guardrail.ts:30-35`). The client classifies only to
choose a dialog.

| Tier  | When                                                                                                                                                                                                                      | What happens                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Load has **not** reached `verified` (status ∈ `arrived … submitted`)                                                                                                                                                      | Manager restates it alone. Audited. **Zero effect on `onHand`** — pre-`verified` rows are not in `VERIFIED_INBOUND_STATUSES`. This is H-135881.                                                |
| **1** | Load is `verified`, `arrived_at` is on a Pacific day **strictly after** the latest physical anchor's Pacific day, no finalized COR covers its cover month, no export pulled for the window, swing ≤ threshold             | Manager alone, but **preview-then-confirm**: the dialog must show the signed program / non-program delta and the resulting floor, in the `describeSwing` sentence style.                       |
| **2** | **Any** of: `arrived_at` on/before the anchor's Pacific day · a finalized COR covers the cover month · status `submitted_to_mymrc` or `processed` · an MRC/SVdP export was pulled covering the window · swing > threshold | **Held.** A second person releases it — never the requester, never the submitting operator. Release emits the downstream task list (supersede the COR, re-issue the export, re-file with MRC). |

Tier 2 is a **hold**, not a rejection — the ADR-0072 rule: _"an operator who counted
1,200 when the floor says 2,483 has either found a real problem or fat-fingered a digit,
and both deserve a person looking, not a timeout."_ The requested values persist intact.
The swing is **recomputed at release** against live state, never trusted from the hold.

### Who may do what

- **Request** a correction: `role === 'manager'` with site reach, or `admin`. Site reach
  is the existing rule — admin POWERS are `role === 'admin'`; site REACH is
  `admin || all_sites` — via `requireActivatedManager`. An operator may never request
  one; the floor's correction affordance is `confirmFloorInboundDay`, which is
  same-day-pinned by `assertCurrentPacificDay`.
- **Release a Tier 2 hold**: a different manager or an admin. Enforced three times over,
  per ADR-0072: in the service, in the route, and by a DB CHECK. The requester can never
  self-release, and neither can the operator who submitted the load.
- **A load with a `NULL` `site_id`** cannot exist (`site_id` is non-nullable), but a load
  whose `source_id` is NULL is **unclassified, never guessed** — `verifyLoad` already
  refuses to default the split blind (`verify-gate.ts:162-168`). A correction inherits
  that refusal.

### Refused outright — not made editable

1. **`load_stacks` are never mutated, ever.** They are the operator's timestamped
   evidence of what was physically counted. A correction restates the header and
   **records `stacks_sum_at_correction`** so the divergence is an explicit, queryable
   fact rather than a silent contradiction. If the stacks are wrong, the honest remedy is
   a re-count, not a rewritten history.
2. **`total_units` cannot move alone on a `verified` load.** All three of
   `total_units` / `program_unit_count` / `non_program_unit_count` move together or the
   write is refused — enforced by `assertProgramSplit` _and_ by a DB CHECK. This is the
   defect the H-135881 hand-correction already introduced.
3. **A blank is not a zero.** An omitted field means _unchanged_. An explicit `0` means
   zero and is accepted only where zero is meaningful. `total_units = 0` on a load that
   physically arrived is refused — a truck that brought nothing is `rejected`, not
   zero-count.
4. **A `rejected` load is terminal.** It has no counts to correct. Re-receive instead.
5. **Aggregate rows (`paper_bulk` / `mymrc_haul` / `ipad_floor`) are out of scope for
   this route.** They keep their own upsert path — but see the consequence below: that
   path must inherit the same classifier, or this ADR just adds friction to the safer of
   two doors.
6. **A correction that would move a load's `arrived_at` into a Pacific day already owned
   by an aggregate row is refused** (double-count). Date changes are refused generally in
   v1: `arrived_at` is the key `onHand`, the unique index, and the export window all
   depend on.
7. **Silently restating something already sent to MRC is refused** — and today that
   cannot be honoured at all, because nothing records what was sent. See the blocking
   dependency below.

### Effect on `onHand` — precisely

`onHand` (`running-balance.ts:281-308`) sums `program_unit_count` + `non_program_unit_count`
where `status ∈ {verified, submitted_to_mymrc, processed}` **and**
`arrived_at >= inboundSince`, where `anchorFlowBounds` sets
`inboundSince = pacificMidnight(anchorPacificDay + 1)` — the anchor is that day's
**closing** position, so its own day's flows are already inside the count.

| Case                                                  | Effect on the live floor                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load not yet `verified`                               | **None.** Not in `VERIFIED_INBOUND_STATUSES`. Applies now and until it is verified.                                                                     |
| `verified`, `arrived_at` Pacific day **≤** anchor day | **None.** `anchorFlowBounds` excludes it; the physical count already counted those mattresses. **The floor must not move, and it does not — for free.** |
| `verified`, `arrived_at` Pacific day **>** anchor day | Moves **1:1**: program pool by `after_program − before_program`, non-program by `after_non_program − before_non_program`. Immediate, no recompute.      |
| Any case, `total_units` changed alone                 | **None** — and the split invariant is now broken. Refused.                                                                                              |

The pre-anchor case is the subtle one and is why it is Tier 2 despite moving nothing.
It does not touch the live floor, but it **retroactively falsifies three recorded
things**: the anchor snapshot's stored `reconciled_delta` (computed as
`physical − computed` at write time — `running-balance.ts:396`), any `startBalance` /
`inventory-close` recomputation over a window spanning it, and the MRC CSV for that
month. "The floor didn't move" is not the same as "nothing changed," and a mechanism
that treated it as friction-free would be exactly the shape of defect this codebase keeps
correcting.

### Data model

```sql
-- 1. Inbound loads finally get the lock every sibling model already has.
ALTER TABLE inbound_loads ADD COLUMN locked_at TIMESTAMPTZ NULL;

-- 2. The append-only correction record.
CREATE TABLE inbound_load_corrections (
  id   TEXT PRIMARY KEY,
  load_id TEXT NOT NULL REFERENCES inbound_loads(id) ON DELETE RESTRICT,
  site_id TEXT NOT NULL REFERENCES sites(id),

  -- Before / after. NULL on an "after" column means UNCHANGED, never zero.
  before_total_units            INTEGER, after_total_units            INTEGER,
  before_program_unit_count     INTEGER, after_program_unit_count     INTEGER,
  before_non_program_unit_count INTEGER, after_non_program_unit_count INTEGER,
  before_weight_lbs             INTEGER, after_weight_lbs             INTEGER,

  -- The evidence divergence, recorded rather than resolved. Stacks are never touched.
  stacks_sum_at_correction INTEGER NOT NULL,

  tier          SMALLINT NOT NULL,
  reason        TEXT     NOT NULL,
  -- The computed preview, frozen as the record of WHY it was classified this way:
  -- { onHandDeltaProgram, onHandDeltaNonProgram, anchorId, anchorPacificDay,
  --   preAnchor: bool, corCertificateIds: [], exportPullIds: [], swingPct }
  downstream_impact JSONB NOT NULL,

  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | discarded
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  TEXT REFERENCES users(id),
  approved_at  TIMESTAMPTZ,
  approval_path TEXT,                            -- 'pin' | 'remote'
  discarded_by TEXT REFERENCES users(id),
  discarded_at TIMESTAMPTZ,
  discard_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The rule that matters most is the one a future code path cannot bend (ADR-0068).
  CONSTRAINT ilc_approver_not_requester
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT ilc_tier_valid   CHECK (tier IN (0,1,2)),
  CONSTRAINT ilc_reason_real  CHECK (char_length(btrim(reason)) >= 10),
  CONSTRAINT ilc_approval_path_valid
    CHECK (approval_path IS NULL OR approval_path IN ('pin','remote')),
  -- Tier 2 can only be 'applied' with a real, attributed second person.
  CONSTRAINT ilc_tier2_needs_approval
    CHECK (tier < 2 OR status <> 'applied'
           OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_path IS NOT NULL)),
  CONSTRAINT ilc_discarded_is_attributed
    CHECK (status <> 'discarded' OR (discarded_by IS NOT NULL AND discarded_at IS NOT NULL)),
  -- The split invariant, in the database, not only in verify-gate.ts.
  CONSTRAINT ilc_split_reconciles
    CHECK (after_total_units IS NULL
           OR after_program_unit_count IS NULL
           OR after_non_program_unit_count IS NULL
           OR after_total_units = after_program_unit_count + after_non_program_unit_count),
  -- All three move together or none do.
  CONSTRAINT ilc_split_moves_together
    CHECK ((after_total_units IS NULL) = (after_program_unit_count IS NULL)
           AND (after_total_units IS NULL) = (after_non_program_unit_count IS NULL))
);
CREATE INDEX ilc_load_idx ON inbound_load_corrections (load_id, created_at DESC);
CREATE INDEX ilc_pending_idx ON inbound_load_corrections (site_id, status, created_at DESC);
```

**Companion table — the blocking dependency.** The constraint _"never silently restate
something already sent to MRC"_ is **unenforceable today**, because the MRC CSV route
keeps no record of having been pulled. It needs:

```sql
CREATE TABLE mrc_export_pulls (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  export_kind TEXT NOT NULL,          -- 'mrc_monthly' | 'svdp'
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  row_count    INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,       -- what was actually handed over
  pulled_by TEXT NOT NULL REFERENCES users(id),
  pulled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Without it the Tier 2 "export pulled" trigger cannot fire and the mechanism ships with a
hole in exactly the place the design constraint names. `content_sha256` also converts
"did the file we sent change?" from a guess into a comparison.

### Reuse, not reinvention

| Need                                                     | Existing thing to reuse                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Tier classification + threshold-as-setting               | `classifyAnchorWrite`, `loadSwingThresholdPct`, `InventoryAnchorConfig`          |
| Hold / release / discard lifecycle + PIN-or-remote paths | `src/lib/inventory/anchor-holds.ts`                                              |
| Second-person CHECK constraints                          | migration `20260823_adr0072_anchor_overwrite_guardrail`                          |
| Split enforcement                                        | `assertProgramSplit` (`verify-gate.ts:61`)                                       |
| Lock semantics + typed 409                               | `assertUnlocked` / `RecordLockedError` (`record-guards.ts:98`)                   |
| Typed-error → HTTP mapping                               | `loadsErrorResponse` (`route-helpers.ts`)                                        |
| Surface gating                                           | `assertUiSurfaceActivated` with a new `manager_load_corrections` code (ADR-0065) |
| Human-readable delta sentence                            | `describeSwing` (`anchor-guardrail.ts:186`)                                      |

---

## Does this extend to processed / daily production rows? — **No.**

Three independent reasons.

1. **It would become a second writer.** `processed_units_daily` already has a precedence
   discipline keyed on `source` + `closed_at`: the MyMRC bridge only overwrites rows
   `WHERE source = 'mymrc' AND closed_at IS NULL`
   (`src/lib/mymrc/processed-bridge.ts:140-143`), and never touches a human row. A
   correction route that wrote the table directly would sit outside that predicate and
   break the one rule holding three writers apart. (Note: the premise that workbook-sync
   is the _sole_ writer is not accurate — the super-admin entry route and the MyMRC
   bridge both write it. What is real is the **precedence** rule, and it must not be
   given a fourth participant.)
2. **It already has its own correction discipline, and it is a different shape.**
   `closed_at` locks the day and post-close edits are refused with a typed error
   directing to an amendment path (`processed-units.ts:175-179`), mirroring ADR-0028.
   Above that sits ADR-0032's `BonusReportingAdjustment` — a deliberately
   **reporting-only** additive layer that corrects reported totals without moving payroll
   dollars. That layering is correct for production because production feeds **payroll**,
   which is signed and frozen. Inbound feeds **inventory**, which is a running balance.
   Different hazards, different mechanisms.
3. **The right work on production is to finish what is already declared**, not to add a
   parallel system: the amendment path that `processed-units.ts` refuses into **does not
   exist**, and `BonusReportingAdjustment` has **no write API** — its five prod rows were
   inserted by hand, which is the same DBA-shaped hole this ADR closes for inbound. That
   is a separate ADR.

---

## Consequences

- **The aggregate paths must inherit the classifier, or this ADR is theatre.**
  `upsertBulkInboundDay` and `confirmFloorInboundDay` can already rewrite a verified past
  day with no anchor, COR, or export check. Shipping a guarded per-load route while the
  aggregate door stays open would add friction to the _safer_ of the two paths. This is
  the highest-value item in the whole ADR and should land first.
- **A Tier 2 release produces work, and the work must be named.** Supersede the affected
  COR (`supersedeCor` → re-enter FT/PT → re-finalize), re-pull and re-send the MRC CSV,
  note the invalidated `reconciled_delta`. Vision cannot do any of it automatically and
  must not pretend to.
- **`inbound_loads` gains a lock it has never had**, which means a lock policy question
  that does not exist yet: what locks an inbound load, and when? Proposed default: month
  close locks it; nothing else does. Until that is answered, `locked_at` ships as a
  column and a guard with no automatic setter — explicit, not implied.
- **H-135881 is left consistent but flagged.** Its `total_units = 95` stands; its stacks
  sum to 40. Backfilling a correction record for it is the first use of the new table, and
  `stacks_sum_at_correction = 40` is exactly the fact worth keeping.
- **Two live defects found here are not fixed by this ADR** and need their own work: the
  `2026-07-29` aggregate/per-load double-count exposure, and the fact that the ADR-0060 D5
  guard checks only `verified` per-load rows when nine `submitted` ones are waiting.

## Verification

Before this can be called done:

1. `onHand` is byte-identical before and after a Tier 0 correction on an unverified load.
2. A Tier 1 correction on a post-anchor verified load moves `onHand` by exactly the
   program/non-program deltas — asserted with real `Prisma.Decimal` values.
3. A correction on a **pre-anchor** verified load leaves `onHand` unchanged, and the
   correction record's `downstream_impact.preAnchor` is `true`.
4. `total_units` cannot be changed alone: refused in the service **and** by the DB CHECK
   (test the constraint directly, not only the service).
5. The requester cannot release their own hold — service, route, and DB CHECK each
   refused independently.
6. `load_stacks` are untouched by every path, asserted by row-count and checksum.
7. A correction inside a finalized COR month classifies Tier 2 and names the certificate.
8. Migration uses **TEXT** ids, never UUID (the deploy-blocking convention).
