# ADR-0083 — Saves are PAID units, not PROCESSED units

**Date:** 2026-08-08
**Status:** Accepted, implemented
**Supersedes:** nothing. **Amends:** ADR-0019 §1 (the payout basis is now `mattress_count + saves`), ADR-0028 (the four-eyes routing predicate weighs both paid columns), ADR-0033 (the reconcile recompute includes saves), ADR-0037 (first writer of the `unit_status_movements` ledger).

## Context

JT (Janette), from the floor: _"add a space for saves — they also get paid for every mattress saved to sell — a dedicated 'saves' field beside processed."_

Bill's ruling: saves is a **new column in the SAME bonus daily entry**, under the **same amendment rules**, paying at the **processing rate**, and it **becomes resale inventory**.

That sounds like one column. It is nine read paths, a four-eyes security gate, a silent zod strip, an append-only inventory ledger with no existing writers, and a payroll tripwire that refuses to print paycheques when two computations of the payout disagree. This ADR records the decisions, because most of them are places where the obvious implementation is quietly wrong.

### The three defects this work had to close before adding anything

| #   | Sev      | Defect                                                                                                                                                                                                                                                                                                                                          | Status |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1  | CRITICAL | **Four-eyes bypass.** `shouldRequireAmendment` compared `mattress_count` only. A non-admin manager editing a PRIOR day and changing only saves would compute `countChanged === false`, fall into the `note_only_edit` branch, and write an unapproved change to a processor's pay — no approver, no justification, nothing in the review queue. | Closed |
| S2  | HIGH     | **Silent zod strip.** The amendments endpoint's `NewValue` schema listed `mattress_count` and `note`. Zod strips unknown keys silently, so a correctly-posted saves amendment would have had the field deleted at the edge — and every downstream step would then behave perfectly on the truncated payload.                                    | Closed |
| S3  | HIGH     | **Reconcile drift.** `reconcile-fetch.ts` recomputes each period's total and pages URGENT + refuses the payroll PDF on a mismatch. Adding a term to the payout formula without adding it here would make every period containing a save refuse its own payroll.                                                                                 | Closed |

None of the three fails loudly. S1 writes a valid-looking row. S2 produces a green audit trail asserting a correction happened. S3 would have fired, but only after the change shipped, on a real pay day.

## Decision

### 1. Paid units = `mattress_count + saves`, tiered ONCE

The Woodland rule (ADR-0019 §1) is **tiered, not flat**:

```
daily_bonus = MAX(units - 50, 0) * $0.50 + MAX(units - 74, 0) * $0.25
```

So "pays at the processing rate" has two candidate readings, and only one of them pays anybody:

- **Summed (chosen):** `bonus(mattress_count + saves)`. A day of 40 processed + 20 saved is 60 units of work → `(60-50) * $0.50 = $5.00`.
- **Separate (rejected):** `bonus(mattress_count) + bonus(saves)` = `$0.00 + $0.00` = **nothing**, because each column sits under the 50-unit threshold on its own.

The separate model applies the threshold **twice**, granting every processor a second unpaid allowance. It would have meant "we shipped a saves column and nobody was ever paid for a save" for any processor whose split straddled the threshold — which is most of them — and it would have done so without throwing, warning or logging. At 60 processed + 60 saved it under-pays by **$36.50 on a single day for a single processor**.

Summing is what "a save is a paid unit" means. Pinned by `__tests__/paid-units.test.ts`.

### 2. One definition of a paid unit, in one module

`src/lib/bonus/paid-units.ts` holds `dailyPaidUnits` / `dailyBonusCentsFor` / `periodBonusCentsFor`, and **every** bonus-dollar path calls it: the grid, the month page, the month list, the aggregates, the current-period standings, the PDF data, the signed PDF page, the sign-time lock, and the ADR-0033 reconcile.

The alternative — each path doing `mattress_count.toNumber() + saves.toNumber()` inline — is nine copies of a payroll policy. The reason ADR-0019 put the tier maths behind one calculator is the reason this needs one funnel: the number on the screen, the number on the signed PDF and the number the reconciler independently recomputes must be incapable of disagreeing.

### 3. Saves are paid units. They are NOT processed units.

This is what makes the double-count **structurally impossible** rather than merely avoided.

A saved mattress is diverted to resale; a processed mattress is torn down for commodity. They are disjoint quantities in two separate columns, and no mattress is ever in both.

| Path class                                                 | Basis                    |
| ---------------------------------------------------------- | ------------------------ |
| PAY (bonus cents, sign-time lock, reconcile, PDF)          | `mattress_count + saves` |
| PRODUCTION QUANTITY (daily report MTD/annual, 8 PM report) | `mattress_count` alone   |
| THROUGHPUT QUOTA (ADR-0071 processor quota)                | `mattress_count` alone   |

`daily-report.ts` and `processor-quota.ts` are **deliberately unchanged**, and each carries a comment at the call site saying so and pointing at `paid-units.ts`. The reasoning: production figures sit adjacent to MRC billing, and a saved mattress was never torn down — counting it as production would inflate a reported throughput with units that were not processed. Folding saves into the ADR-0071 quota would separately have raised every processor above a threshold calibrated on processed units alone; if Bill later wants the quota to measure total handled work, that is a deliberate re-calibration, not a default we slipped in.

The grid footer reports the two totals in **separate cells** for the same reason. The Bonus total beside them is the combined figure, because pay is what the two quantities have in common.

### 4. `NOT NULL DEFAULT 0`, and why that zero is TRUE

Every pre-existing `bonus_daily_entries` row was keyed on a floor that was not capturing saves in the bonus entry at all. The true statement about those rows is "this employee's saves contribution to bonus that day was zero" — **not** "we don't know". Nobody was paid for a save before the column existed, so a real 0 is what the payroll record already means. This is a genuine zero, not a not-recorded modelled as one; a nullable column would assert an uncertainty that does not exist and would put a `?? 0` on all nine pay paths, which is where a silent null-to-zero bug lives.

That truthfulness is **load-bearing**. Because the backfill is a real zero, `bonus(mattress_count + 0)` is byte-identical to `bonus(mattress_count)` for every historical row, so every already-signed period reconciles at **zero drift** and no page fires. A nullable column or any non-zero backfill would have made every signed period in the system report drifted on its next PDF render.

`Decimal(5,1)` mirrors `mattress_count` exactly — the two are summed on the pay path, and a different precision would put a rounding seam inside a payroll addition.

### 5. Absent `saves` on the wire means UNCHANGED, never zero

The floor and office run browser tabs that outlive a deploy. A stale tab posts an entry body with no `saves` key.

- **insert** → 0 (the column default; nothing keyed, nobody owed)
- **update** → the stored value is preserved

The other reading — absent ⇒ write 0 — is destructive and was rejected: a manager on a stale tab correcting somebody's _note_ would silently zero that processor's saves for the day and underpay them, with the write looking entirely routine in the audit log. "Not supplied" and "zero" are different claims, and payroll is where that distinction has to hold. Clearing saves stays possible: a current client sends an explicit `0`, and the grid always does.

The amendment **endpoint** takes the opposite line — `saves` is REQUIRED there, not optional. An amendment is a deliberate, justified, approved correction; a client too old to name the field should be rejected loudly rather than have a proposal inferred for it.

### 6. The four-eyes gate weighs both paid columns (S1)

`shouldRequireAmendment` now compares `saves` alongside `mattress_count`. A prior-day change to **either** is an amendment. The `note_only_edit` exemption survives, narrowed to what it was actually written for: a note cannot change anybody's pay; saves can.

A `null` `existingSaves` on a row that has an `existingCount` means the row predates the column, so the stored value is the default `0` and that is what a proposal is compared against. Reading null as "no change possible" would have reopened the bypass for exactly the historical rows most likely to need correcting.

### 7. The approver is shown what they are approving

`amendment-display.ts` builds the change label once for the review queue, the batch modal and the notification. Three hand-rolled formatters would drift, and the drift has a specific victim: an approver shown `76 → 76` (or nothing at all) clicking Approve on a change whose entire content was the saves move. That is worse than not showing it, because it manufactures the appearance of review.

A pre-ADR-0083 request row carries no `saves` key; it renders as **absent**, not as `0` — claiming a historical request proposed zero saves would be inventing a fact about a payroll record.

### 8. Inventory leg: first writer of `unit_status_movements`

A save records an `on_floor → saved` movement on the ADR-0037 aggregate movement ledger. That table has existed in the schema **with zero writers**; this is the first.

**A save does NOT decrement the live floor balance.** This is the G1 resolution and it is binding. Kelsey's Addendum-A §A.2 immediate-subtraction model is **retracted**; Rick's live model is what the floor actually does — a saved unit is set aside but stays physically on the floor until it is transferred to a store, and leaves inventory on the `saved → sold` transfer. `running-balance.ts` already encodes this by omitting `savedUnits` from `onHand`; this work writes the ledger row **without touching that path**, so the floor tile and the COR numbers do not move when somebody saves a mattress. A save adds resale stock; it does not remove a mattress from the floor. Counting it as both would be the double-count.

**Nothing is written to `processed_units_daily.`** That table has three writers under a precedence rule (`source='mymrc' AND closed_at IS NULL` wins). A save is not a processed unit, so it has no business there at all — and staying out is how we respect the precedence rule rather than race it. The test enforces this with a transaction double that **throws on any model except `unitStatusMovement`**, so a stray write fails by name rather than by review.

**Movements are DELTAS.** The bonus entry is upserted (10 keyed, corrected to 14); the ledger is append-only and signed-sum, so the correct row is `+4` — not a second `+14`, and not an edit of the first row. A downward correction is written as a **reversing** `saved → on_floor` row rather than negative units, because `units` counts units crossing a bucket boundary and a negative count is not a thing that happened. A zero delta appends nothing.

The movement is written **on the caller's transaction**, alongside the entry and its audit row. A paid save whose inventory movement committed separately is exactly the split-write this repo has been bitten by before.

### 9. Truthful typing at the structural boundaries

`SignatureDb.bonusDailyEntry.findMany` declares `saves` **required**, as does `AmendmentEntryDb` and `PdfEntry`. These are the contracts the sign-time lock and the signed PDF read through. An optional field there would let a caller or a test double hand the lock rows without saves: the lock would total processed-only, the reconcile would total processed+saves, and every period containing a save would page URGENT and refuse its own payroll PDF. Required makes that a compile error instead of a 3 a.m. page — the same discipline `DecimalLike` itself exists for.

`calculateDailyBonusCents`'s `TypeError` on a non-`number` is **kept**; callers coerce Decimals through `paid-units.ts`.

## Falsifications run

A green test proves nothing until you have watched it go red. Both named hazards were falsified against the **shipped** code, not a copy:

**S1 — four-eyes bypass.** Reverting `shouldRequireAmendment` to the count-only comparison turned `four-eyes-saves.test.ts` red on 3 of 6 assertions, each `expected 'direct' to be 'amendment'` — i.e. the prior-day saves-only pay change landing unapproved.

**S2 — silent zod strip.** Removing the `saves` key from `AmendmentNewValue` turned `amendment-saves-carry.test.ts` red on 4 of 8, including `expected { mattress_count: 76, note: null } to deeply equal { mattress_count: 76, saves: 9, … }`.

The second falsification also **corrected the test itself**. The first draft asserted against a copy of the schema pasted into the test file, which would have stayed green through any change to the real endpoint — measuring the copy instead of the code. The schema was hoisted to `src/lib/bonus/amendment-schemas.ts` so the route and its tests validate against one definition. This is the "a falsification can measure the mock" failure, caught by attempting the falsification rather than assuming it.

**Historical parity** is pinned by `saves-historical-reconcile.test.ts`, which additionally asserts that the recompute _does_ see saves — a recompute that simply never read the column would also produce zero drift on historical rows while being catastrophically wrong on new ones, so "correct" had to be distinguished from "accidentally passing".

## Consequences

- The bonus grid has five columns. The pay basis for every Woodland processor changes from processed to processed+saved, effective the first entry keyed after deploy.
- **Historical signed periods are unaffected** — verified zero drift, no page, PDFs unchanged.
- `unit_status_movements` starts accumulating rows for the first time. Nothing reads it yet; the `saved` bucket's signed sum is now meaningful and the `saved → sold` store-transfer writer remains unbuilt.
- The ADR-0071 quota and the daily production report keep measuring processed units. If the floor's understanding of "throughput" turns out to include saves, that is a deliberate re-calibration for Bill.
- A pre-ADR-0083 amendment request row applies **without touching saves** rather than coercing a missing key to 0.

## Alternatives considered

**Bonus computed per column separately.** Rejected — see §1. Pays nothing, silently.

**A separate `saves_daily_entries` table.** Rejected: Bill's ruling is the same entry under the same amendment rules, and a second table would need its own amendment workflow, its own approver routing and its own sign-time lock — the ADR-0079 finding that the amendment workflow has exactly one consumer and is not a reusable house pattern applies directly.

**Nullable `saves` column.** Rejected — see §4. Models an uncertainty that does not exist and breaks historical reconcile parity.

**Saves decrementing the live floor balance.** Rejected — this is the retracted Kelsey model; Rick's live model is binding (G1).

**Writing saves into `processed_units_daily`.** Rejected — a save is not processed, and that table's three-writer precedence rule is not ours to contend with.

## Related

- ADR-0019 / 0019.1 — the bonus engine and the tiered Woodland formula
- ADR-0023 — `Decimal(5,1)` counts and the historical import
- ADR-0028 / 0029 — the four-eyes prior-day amendment workflow and batch submission
- ADR-0033 — the payout reconcile tripwire and the sign-time lock
- ADR-0037 — the aggregate inventory ledger and the Rick/Kelsey saved-units ruling
- ADR-0071 — the processor production quota (deliberately unchanged)
- ADR-0084 — same-day physical-count void (the sibling phase of this handoff)

---

## Amendment 1 (2026-08-08) — the amended-month editor can set `saves`, and the last pay path that bypassed the funnel

**Status:** Accepted, implemented. Extends §2 (one funnel) and §5 (absent means
unchanged) to two surfaces this ADR shipped without. Nothing in ADR-0083 is
reversed.

### Context

ADR-0083 added a fifth paid quantity to the daily entry. `AmendmentPanel`
(`/bonus/months/[id]`, the admin editor for a re-opened period) shipped with four
columns and posted `{bonus_employee_id, mattress_count, note}`.

That mattered because it is the **only** editor that reaches an already-signed
period: the primary `DailyEntryGrid` refuses a locked month, and this panel is
what an admin uses after unlocking one. So a mis-keyed saves figure inside a
signed period had no correction surface anywhere in the app.

Nothing was ever lost by the gap — §5's "absent means UNCHANGED, never zero" made
it non-destructive by construction, so correcting a count there left that day's
saves alone. But it had a deadline: ADR-0083 shipped 2026-08-08, so **no signed
period contains a non-zero save yet, and the first one closes at the end of the
current bi-weekly period.**

### Decision

**A fifth column on the panel grid, plus `saves` in its POST body**, modelled on
`DailyEntryGrid` down to the three semantics that are easy to get subtly wrong:

1. **`saves` is always sent, never omitted.** The server reads an absent `saves`
   as "leave unchanged" (§5), so a blank box that omitted the field would make
   clearing a value back to zero impossible from the one screen that reaches a
   signed period. A blank box means an explicit `0`.
2. **A row is "keyed" if EITHER box has a value.** Requiring a processed count
   would make a saves-only correction unsubmittable, and a processor who spent a
   shift pulling units for resale has a real, paid day with a zero processed
   count.
3. **The day total tiers ONCE over `count + saves`** (§1), and the saves figure
   gets its own footer cell rather than being folded into the mattress total —
   they are disjoint quantities; the Bonus total beside them is the combined one.

The panel seeds each row's saves box from the stored entry, so a **note-only**
correction re-sends the day's existing saves. Seeding it blank instead would post
`saves: 0` on every note edit — a silent pay cut on exactly this surface.

### The defect this found: §2's "one funnel" claim was not true

`paid-units.ts` opens by asserting that the grid, the signed PDF, the sign-time
lock, the CSV export, the month list, the aggregates and the ADR-0033 reconcile
tripwire all route through `dailyPaidUnits`, so the number on the screen, the
number on the signed PDF and the number the reconciler independently recomputes
cannot diverge.

**`src/app/bonus/months/[id]/page.tsx` did not.** Its per-employee monthly totals
and its read-only grid totals called `calculateDailyBonusCents(mattress_count, rule)`
directly — the last pay-path read in the app that bypassed the funnel. It
understated every processor's month by the entire cash value of their saves, on
the very page an admin unlocks a signed month from and reads the corrected total
on. Nothing surfaced it: the number was well-formed, the page rendered, the suite
was green. Both call sites now use `dailyBonusCentsFor`. The `totalMattresses`
figure beside them stays processed-only — that one is a production quantity (§3).

**So the claim was made structural.** `paid-units-callers.guard.test.ts` reads
the actual source of every `calculateDailyBonusCents` call in `src/` and fails
the build on any caller outside the funnel that is not allowlisted with a written
reason and a `mustContain` token proving its compensating control survives. Three
entries today: `daily-report.ts` (a production path, §3) and the two client grids
(raw input strings, not DB rows, so they inline the policy — the token pins the
summed `(n ?? 0) + (sv ?? 0)` shape). The guard asserts its own call-site count,
so a rename or a broken glob fails loudly instead of reporting green while
matching nothing, and it strips comments before matching so it cannot read the
token out of the prose explaining the token (the trap the ADR-0084 guard hit).

### On four-eyes: the brief's premise was wrong, and this is what the control is

The change brief described this editor as "the same `shouldRequireAmendment`
path". It is not, and that was checked against the code rather than assumed:
`shouldRequireAmendment` is reached only from `upsertDailyEntries`
(`daily-entry.ts`), the PRIMARY grid's path. `upsertAmendedMonthEntries` does not
import it and never has.

That is by design. This surface is reachable only after an admin has explicitly
unlocked a signed month **with a written reason, which clears both signatures**;
the corrected month must then be re-submitted and re-signed by two signers before
it pays. The four eyes here are the two re-signatures applied to the whole
corrected month, not a per-edit approval request — filing one would queue an
approval for a change nobody can act on until the re-signing happens anyway.

What must NOT become true is that this path moves a signed month's numbers
_without_ that unlock. Pinned behaviourally (a locked month is refused
`month_locked`, nothing written, no audit row) and structurally (an assertion
that `amendment.ts` does not reference `shouldRequireAmendment`, so wiring it in
forces a deliberate decision). §6's own gate is separately re-pinned from the
saves angle, so widening this editor cannot become an argument for relaxing that
one.

### Falsifications run

| Falsification                                                            | Result                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Drop `saves` from the panel's POST body                                  | **RED ×4** — including `expected undefined to be +0` on the clear-to-zero case                                   |
| Seed the panel's saves box blank instead of from the stored entry        | **RED ×3** — the note-only edit posts `saves: 0` for a day that had 9; `$7.50` day total reads `$0.00`           |
| Make an absent `saves` mean `0` in the service (`input.saves ?? 0`)      | **RED** — a note-only edit zeroes 9 saved mattresses; 2,000¢ → 1,325¢, **$6.75 under-paid on one day**, silently |
| Restore `calculateDailyBonusCents(count, rule)` on the month detail page | **RED ×3** in the guard, naming the file and line and the fix                                                    |
| Tier the two columns separately instead of over their sum                | **RED** — a 45 + 20 day pays $7.50 summed and **$0.00** tiered twice                                             |

### Residuals

- The month detail page's totals are corrected but were **not** verified against
  production data; no signed period contains a non-zero save yet, so there is no
  live number to compare. The correction is proven by the guard and by
  `paid-units.test.ts`, not by a prod read.
- The panel remains English-only (ADR-0017), unchanged by this amendment.
