# ADR-0143 — The program pool is a claim, not a count: a negative is caught where it is written

- **Status:** Proposed 2026-10-29 (Pacific). Diagnosis is measured; the design waits on Bill's decisions
  B1–B6 (plan §6). Nothing in this ADR is implemented yet.
- **Context:** Bill, 2026-10-29: _"we have not gotten to where we need to be with the inventory problems...
  this is important and an ongoing important need. This needs to be rectified and repaired - this can't be a
  recurring issue - we have tried to make this right way too many times."_
- **Extends:** ADR-0037 D6 (one running balance), ADR-0110 (D3 negative is a diagnostic, Am.1 names the
  cause), ADR-0131 (the invariant suite). **Amends:** the ADR-0131 `INV-POOL-NON-NEGATIVE` remedy text, which
  contradicts ADR-0110 Am.1 (see RC4).
- **Plan:** `docs/plans/2026-10-29-inventory-negative-permanent-fix.md`.
- **Evidence query (read-only, re-runnable):** `docs/queries/2026-10-29-inventory-pool-diagnosis.sql`.

Markers: `[M]` measured on prod 2026-10-29 between 8:10 and 8:55 AM PDT (read-only transaction, aggregates
only). `[C]` read in code at `origin/main` `3573f74`. The live app image was built 2026-10-14 4:04 PM PDT, after
the last app commit `d4a5e12`; every later commit is `[skip-deploy]` tunnel-only. The live bundle carries the
cited strings ("Program on hand", the ADR-0110 Am.1 wording), so the code cited here is the code running. `[I]`
inferred.

## What is negative

| Site     | Anchor (physical count)     | Program pool | Non-program pool | Total |
| -------- | --------------------------- | -----------: | ---------------: | ----: |
| Woodland | 2026-09-14, 885 = 128 / 757 |     **−247** |             +644 |  +397 |
| Eugene   | 2026-09-16, 751 = 19 / 732  |          +19 |             +732 |  +751 |

`[M]` Woodland is **case 1 of ADR-0110 Am.1** (program < 0, total > 0). The building holds about 397 units.
The program/non-program split is what is wrong. Eugene is not negative, but it has no flow rows at all since
its first count, so its 751 is a constant, not a measurement (ADR-0110 already says this).

Woodland since the anchor `[M]`: anchor 128 program + inbound 26,406 + drop-offs 243 − stripped 27,024 = −247.
Non-program: 757 + 3,057 − 3,170 = 644. Whole units sold and landfilled are 0.

## What the measurement rules out

This is the first negative that **no missing feed explains**:

1. **Inbound is complete.** The 34 bridged `mymrc_haul` day rows (26,406 / 3,057) equal the MyMRC hauls mirror
   exactly: 312 `Delivered` `General` hauls, 26,406 / 3,057, 0 undated, 0 consumer-drop-off hauls. `[M]`
2. **Stripped agrees across two independent sources.** The Woodland workbook sync rows (`source='import'`,
   33 days) equal the MyMRC processed mirror week by week, both pools, for every week since 09-07. One week
   (08-31) differs by 12 units in the split, not the total. `[M]`
3. **No duplicate dock loads.** The 234 floor dock loads in the window are `submitted` with no pool split, so
   they are excluded (ADR-0142). `[M]`
4. **Every alert fired.** `INV-POOL-NON-NEGATIVE` paged `dr3-vision-system` at 02:30 PT every day the ntfy cache
   still holds (10-23 through 10-29), with "woodland program: −247 units". `[M]` The negative was announced
   and not acted on. See RC4.

## The mechanism

The trajectory of Woodland's program pool since the 09-14 anchor `[M]`:

| Period        | Program pool      | Processing days | Non-program processed = 0 | Program processed = program intake + drop-offs |
| ------------- | ----------------- | --------------: | ------------------------: | ---------------------------------------------: |
| 09-15 → 10-08 | 128 → −243 (−371) |              19 |                    **17** |                                              0 |
| 10-09 → 10-28 | −243 → −247 (−4)  |              14 |                         3 |                     **7 exact, 12 within ±25** |

- **09-15 → 10-08.** 1,033 non-program units were delivered, and only 248 were recorded processed as
  non-program. On 17 of 19 days the non-program processed figure was 0. Over the same weeks the program pool
  fell by 371 and the non-program pool rose by 881, while the total stayed positive (885 → 1,395). This is
  what it looks like when non-program units are processed and recorded as program. ADR-0110 Am.1 diagnosed the
  same thing on 10-08, but nothing corrected the data afterwards.
- **10-09 → 10-28.** The day's processed-program figure equals that day's program intake plus drop-offs:
  exactly on 7 of 14 days and within 25 units on 12. The program pool has therefore been frozen at −243 to −248
  for three weeks, while the non-program surplus was worked down (1,638 → 644). `[M]` `[I]`: the daily processed
  split is now **derived from intake**, not measured. Under that convention the program pool can never correct
  itself, so the −247 is a fixed residue from September.
- **The same pattern runs through every count interval.** Ledger prediction against the next physical count
  `[M]`:

  | Interval      | Ledger program | Counted program | Ledger non-program | Counted non-program |
  | ------------- | -------------: | --------------: | -----------------: | ------------------: |
  | 06-30 → 07-22 |             52 |           1,597 |                229 |                 886 |
  | 07-22 → 08-18 |            324 |             201 |                397 |                 722 |
  | 08-18 → 09-14 |            397 |             128 |                788 |                 757 |

  The first row is the 07-22 intake freeze (ADR-0089), and the program-pool error is large in every interval.
  Non-program processed was 0 on 21 of 24 July processing days and 20 of 23 September days. `[M]`

## Root causes

**RC1 — The program pool cannot be observed, and it sits on a near-zero buffer.** Program versus non-program
is an MRC account attribute of a haul. Once a mattress is on the floor, nothing physical marks which pool it is
in. The pool on-hand is the difference of two large independent series (about 800 program units a day in and
out) around a real buffer of about 100–400 units. A split error or a one-day timing skew bigger than the buffer
drives it negative. The physical anchors' split (128 / 757) is also a person's call, so even a fresh count
re-seeds the pool with an estimate. `[M]` `[I]`

**RC2 — Nothing checks the split at the door that writes it.** Woodland's processed days are written by the
workbook sync (`src/lib/workbook-sync/upsert.ts:200` `source: 'import'`) and the MyMRC processed bridge.
Neither one evaluates the balance. The only write-time negative guard in the system is
`closeProcessedUnitsDay` (`src/lib/loads/processed-units.ts:308`), and it runs only when a day is closed in
Vision. **Woodland has closed 0 of its 33 days since the anchor in Vision** `[M]`. ADR-0110 D5 calls this class
"a gated capability is only as gated as its least guarded entry point": the guard sits on a door nobody uses.
The split is decided by a person keying MyMRC or the workbook, and Vision learns about it afterwards. `[C]` `[M]`

**RC3 — ADR-0110 D3 was implemented on three of five surfaces.** D3 says a negative figure is _replaced_,
never shown. The production report, the manager floor tile and the overview card do that. Two surfaces print
the raw pool:

- `src/app/dashboard/[site]/loads-inventory/page.tsx:95-97`: "Program on hand **−247**" on the Loads &
  inventory page managers use.
- `src/app/operator/[site]/today/page.tsx:161-164`: program and non-program printed raw on the iPad Today hub
  (`ipad_today_summary` is `pilot` at both sites, so admins such as Bill see it). `[M]`

The COR guard checks the **total** only (`src/lib/cor/prefill.ts:260-263`, `src/lib/cor/inbound-gate.ts:130`),
so a negative program pool, which ADR-0110 D3 calls billing-grade, would pass it. `[C]`

**RC4 — The alert's remedy contradicts the screen, and neither leads to a correction.**

- The `INV-POOL-NON-NEGATIVE` remedy (`src/lib/inventory/invariants.ts:364`) says to compare the legs to the
  workbook and **"do not take a new physical count"**.
- The floor tile (`src/app/dashboard/[site]/floor-inventory-tile.tsx:55`) and the daily report
  (`src/lib/bonus/daily-report-notifications.ts:208`) say **"A physical count resets the floor."**
- The legs already match the workbook (finding 2 above), so the alert's own instruction leads nowhere.
- No tool exists to move units between pools without a count.
- ADR-0110 Am.1 ended with "Not done here: correcting Woodland's mis-keyed split", with no owner and no date.

A daily page with no action is noise. It has been ignored, which is ADR-0037 gate question 1 failing.
`INV-ANCHOR-FRESH` has also paged daily: Woodland's anchor is 45 days old and no count has been taken. `[M]` `[C]`

**RC5 — Every fix so far was local to one input defect.** Each one was correct for the input it fixed. None of
them added a check that runs when the split is written, and none provided a way to correct the split.

| Attempt                             | Claimed to fix                                                          | Did it close the mechanism?                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 07-30 diagnosis + ADR-0070 Am.1     | intake feed frozen; freshness guard blind                               | Closed that feed defect. Did nothing about pool splits.                      |
| ADR-0089 (08-10)                    | inbound keyed on a scheduling field                                     | Yes, for intake completeness. Today's inbound equals the mirror exactly.     |
| ADR-0110 D1–D5 (08-18)              | untaught drop-off kind; negative shown as a figure; ungated anchor door | D3 covered 3 of 5 surfaces (RC3). D5 closed the anchor door.                 |
| ADR-0118/0119/0120 (08-19/20)       | double anchors; bridge overwriting corrections                          | Yes for those classes. Not related to the split.                             |
| ADR-0131 invariants (09-11 → 09-15) | detect a negative pool                                                  | Detects it. The remedy contradicts the screen and offers no action (RC4).    |
| 09-14 hard count (885 = 128/757)    | reset the floor                                                         | Reset it on a person-estimated split. Program went negative 3 days later.    |
| ADR-0110 Am.1 (10-08)               | name the cause ("split mis-recorded")                                   | Named it correctly. The correction was "not done here" and was never routed. |
| ADR-0142 (10-08)                    | dock loads double-counting the day's aggregate                          | Yes for that class. Not related to the split.                                |

## Decision (proposed)

**D1 — One presenter for every on-hand figure.** Add `presentOnHand(balance, context)` in
`src/lib/inventory/negative-floor.ts`. It is the only function allowed to turn a `RunningBalance` into UI or
mail. A negative pool renders the ADR-0110 Am.1 sentence, never the number. Fix the two raw surfaces (RC3).
Add a repo test, modelled on `no-direct-mail.test.ts`, that fails CI when any `.tsx`/mail module renders
`balance.program|nonProgram|total` outside the presenter. The test must assert how many call sites it
inspected, so a scan that silently matches nothing goes red. The COR guard checks both pools.

**D2 — The split is checked where it is written, the same day.** Add one function,
`assertPoolsAfterWrite(tx, siteId, day, writer)`, called inside the transaction of every writer of a ledger
leg:

- workbook-sync `upsertDailyProduction`
- the MyMRC processed and inbound bridges
- `upsertProcessedUnits`, `closeProcessedUnitsDay`
- drop-off capture, outbound renovation, landfilled
- `reconcilePhysicalCount`, `correct-count`, `void-count`

Each call is under the existing `lockSiteAgainstPromotion` site lock. It **never refuses** an external fact
(MRC is the system of record for processed and delivered). When a write moves a pool from ≥ 0 to < 0, it opens
an `inventory_exceptions` row naming the site, the pool, the first negative day, the writer, the day's
in/out legs and the shortfall. This catches the September pattern on day 1 (09-17) instead of day 38.

**D3 — The database enforces "no unexplained negative".** A CHECK on on-hand is not possible: on-hand is
derived, and the inputs are MRC's records, which Vision must not refuse. The invariant Vision _can_ own is
enforced on a materialised daily position table instead:

- New table `inventory_position_daily (site_id, day, pool, opening, inbound, dropoffs, stripped, sold,
landfilled, adjustments, closing, inputs_hash, computed_at)`. A single writer rebuilds it from
  `computePoolBalance`'s legs.
- A constraint trigger rejects any row with `closing < 0` unless it references an `inventory_exceptions` row
  that is open or resolved.
- A negative can therefore exist only as a recorded, owned exception, never silently.
- The table is also the "which day and which leg drove it" history that today takes a hand-written SQL session.

**D4 — A supported correction that is not a physical count.** New append-only `inventory_pool_adjustments`:
`(site_id, day, from_pool, to_pool, units > 0, reason, exception_id, proposed_by, approved_by, approved_at)`.

- `CHECK (from_pool <> to_pool)`. The total is preserved by construction. Four-eyes: the approver cannot be the
  proposer.
- It becomes a sixth leg in `computeRunningBalance` (+ to_pool, − from_pool). It closes the exception it
  references.
- This is the repair for RC1/RC2 data. It resolves the RC4 contradiction: the error is recorded as its own row,
  not absorbed into a count's `reconciled_delta`.
- Pool-split repairs use an adjustment. A physical count stays the reset for **total** drift.

**D5 — One remedy, one page, an action.** Rewrite the `INV-POOL-NON-NEGATIVE` remedy from
`classifyNegativeFloor`, so the invariant, the tile and the report say the same thing.

- On **onset** (D2 opens an exception): page Bill once on `dr3-vision-system`, priority `high`. The click goes
  to the exception page (`/dashboard/<site>/inventory-exceptions/<id>`).
- While it stays open: no daily repeat, one line in the existing daily digest.
- After 7 days open: a single `high` re-page naming the age.
- Site managers get it in-app only (CLAUDE.md hard rule 5: ntfy goes to Bill only).
- Graded against ADR-0037 in the plan.

**D6 — Name the split convention.** Bill and the site decide (B1–B3) how the daily processed split is
determined. The rule is written into the workbook and the Vision daily close, so the split is a measurement
or a stated rule, not an undocumented habit.

## Alternatives considered

- **CHECK (on_hand >= 0) / a stored counter with a guarded decrement.** Rejected. Vision has no stored counter;
  on-hand is ledger-derived, which is correct. The quantities arrive from MRC as facts. Refusing them would make
  Vision disagree with the system MRC pays from. The CAS / `SELECT FOR UPDATE` idioms already guard Vision's own
  writes (ADR-0118/0119). This defect is not a race.
- **Clamp the pool at zero for display.** Rejected. It hides a billing-relevant error. This is the ADR-0110 D3
  reasoning.
- **Drop the pools and track the total only.** This is valid only if Bill rules that the floor split has no
  billing or compliance meaning (B1). Billing does not read on-hand: Vision holds 0 invoices and 0 COR
  certificates `[M]`, and MRC pays from its own processed records. Kept as the fallback answer to B1.
- **Take another physical count.** It resets the number. The split error comes back within days, as it did
  after 09-14. Useful for the total, not a fix.

## Consequences

- Two new tables (`inventory_exceptions`, `inventory_pool_adjustments`), one materialised table
  (`inventory_position_daily`), one constraint trigger, and a sixth leg in `computeRunningBalance`. All are
  migrations, so a `src/` deploy follows. Coordinate the dock iPads first (the deploy rebuild rotates the
  Next.js chunks).
- The −247 stays visible as an exception until a Bill-approved adjustment or count resolves it. The plan carries
  the proposed repair; nothing is written by this ADR.
- MRC exposure: if non-program units were reported to MRC as program in September, the MyMRC processed records
  carry that too (finding 2). Whether that matters is a business question (B2), not something code can decide.
