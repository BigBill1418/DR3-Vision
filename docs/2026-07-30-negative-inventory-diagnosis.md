# Why Woodland's inventory is negative

**Date:** 2026-07-30 (evening PT) · **Branch:** `main` @ `552e21c` · **Access:** read-only against prod
**Status:** **SUPERSEDED 2026-08-10 by ADR-0089.** §6 below _disproves_ the undated-haul
hypothesis, and that disproof is **wrong** — see the §6 banner. The floor is now positive
(+1,382) and the July Woodland COR is unblocked (512 units EOM). Every "currently" and
"today" in this document means **2026-07-30**. Kept unedited below the corrections as the
record of what was measured and concluded that night.

---

## The answer

Woodland's floor currently reads **−3,969 program units**, 886 non-program, **−3,083 total**. `[M]`

The number is negative because **Vision has been told what left the building for the last nine days,
but not what came in.** The intake feed froze on 2026-07-22 and nobody was told. The processing feed
was un-frozen last night. So the ledger has been subtracting all week with nothing being added.

The arithmetic is right. The inputs are half-missing.

Nothing has been billed and nothing has been filed with a bad number — **yet**. The July Certificate
of Recycling is the exposure, and it is due now. See "What's at risk" below.

---

## 1. The reproduced negative `[M]`

**Surface:** the live floor-inventory tile, `DR3 Woodland` dashboard.
Same figure appears on the operator "today" page, the loads-inventory page, the physical-count page,
and the COR prefill — all read the same function.

**Measured 2026-07-30, ~8:40 PM PT**, replicating `onHand()` in SQL against prod:

| Component                          |    Program | Non-program |
| ---------------------------------- | ---------: | ----------: |
| Anchor — physical count 2026-07-22 |      1,597 |         886 |
| + verified inbound since anchor    |        150 |           0 |
| + consumer drop-offs               |          0 |           — |
| − stripped (processed)             |      5,716 |           0 |
| − whole units sold (renovation)    |          0 |           0 |
| − landfilled                       |          0 |           0 |
| **= on floor**                     | **−3,969** |     **886** |

Total = **−3,083**.

Eugene is **not** affected — it has no inventory flow rows at all (every component measured 0, and no
physical snapshot has ever been taken there). `[M]`

---

## 2. The mechanism

`onHand()` — `src/lib/inventory/running-balance.ts:~330` — computes:

```
End = anchor + inbound + dropoffs − stripped − wholeUnitsSold − landfilled
```

The pure function is `computeRunningBalance()` (same file, ~line 120). Both are correct. The tile that
displays it (`src/lib/dashboard/floor-inventory-tile.ts:104`) is a thin read and re-derives nothing.

**The missing input is inbound.** Two facts, measured:

1. **All five `processed_units_daily` rows in the window were written last night**, 2026-07-30 7:23 PM PT,
   `source='mymrc'` — 07/23 (1,063), 07/24 (1,076), 07/27 (1,163), 07/28 (1,165), 07/29 (1,249) = **5,716**. `[M]`
   These arrived because commit `552e21c` fixed the processed scraper, which had been pinned to the
   oldest 50 records and reporting `ok` for nine days. Nine days of production landed at once.

2. **No inbound load exists for 2026-07-22 onward except one manual 150-unit entry on 07-29.** `[M]`
   The last bridged inbound load is `arrived_at = 2026-07-21`.

**Why inbound is missing — root cause.** Delivered hauls only ever entered Vision through the ADR-0057
one-shot backfill cursor `completed_hauls`. That cursor shows `completed_at = 2026-07-22 2:07 AM PT`,
`records_completed 8000 / estimated 6185`. `[M]` A drained cursor is a no-op, so it has never run again.

Confirming this is the live state, not history: **every one of the 7,174 `Delivered` haul rows has
`last_seen_at = 2026-07-22`**, while the 71 `Confirmed` (upcoming) rows are still refreshed daily —
17 of them were seen tonight. `[M]` Delivered hauls leave the active list view, so nothing re-reads them.

Historic Woodland intake runs ~500–1,400 program units per production day. Seven production days of
missing intake is roughly 5,000–6,000 units — which matches the 5,716 stripped almost exactly. `[I]`
_Falsified if_ the backfilled hauls, once ingested, total materially less than ~5,000 units for 07/22–07/29.

---

## 3. Display bug or data integrity?

**Data integrity.** The negative is arithmetically correct given the data present. `computeRunningBalance`,
`onHand`, and the floor tile are all behaving as designed.

There is one genuine **design fault** alongside it: `onHand()` has no concept of input freshness. It will
compute and render a number from a one-sided ledger without any indication that half its inputs are nine
days stale. The code even anticipates negatives — `computeProgramPoolProjection` in
`src/lib/dashboard/floor-inventory-tile.ts` clamps days-remaining with the comment _"A negative pool
(drifted ledger awaiting a physical count) projects as 0 days — 'you are already out'"_ `[D]` — so a
negative was a known possible state, but it was never made loud.

---

## 4. How far back, and is it worsening?

It is a **drift, not a one-off.** Program units on the floor, by day: `[M]`

| Date     |        Program on floor |
| -------- | ----------------------: |
| 07-23    |                     534 |
| 07-24    | **−542** ← crosses zero |
| 07-25/26 |          −542 (weekend) |
| 07-27    |                  −1,705 |
| 07-28    |                  −2,870 |
| 07-29    |                  −3,969 |
| 07-30/31 |                  −3,969 |

It went negative on **2026-07-24** and deepens by roughly **1,100 units every production day**. It will
keep deepening until the inbound feed is restored. Note it only _appeared_ last night — the processed
backfill made nine days of drift visible in one step.

---

## 5. What's at risk downstream

**Read this first.**

**COR — Certificate of Recycling. This is the live exposure.** `src/lib/cor/prefill.ts:148` sets the
filed inventory figure directly from `balance.total`, and `src/lib/cor/service.ts:238` refuses to
finalize if the stored figure and the recomputed ledger disagree. `[D]`
July's month-end is **today**. If anyone prefills the July Woodland COR right now, it will carry
**−3,083 units** as the reported inventory on a regulatory filing.
Currently `cor_certificates` holds **0 rows** — nothing has been filed yet. `[M]`

**Billing — not affected by the negative.** Invoicing does **not** read `onHand`. It bills off
`processed_units_daily.stripped_program` directly (`src/lib/invoices/generation-inputs.ts:124-128`
and `:226-230`). `[D]` `invoices` holds **0 rows**. `[M]`

**Bonus engine — not affected.** `src/lib/bonus/daily-report-notifications.ts` mentions `onHand` only
in a comment; there is no call. `[D]`

**A separate billing finding, worth acting on.** The six processed records marked `disappeared_at` last
night are all old (2024-03 → 2025-09) and cannot affect the current negative. But two of them are exact
duplicates that MRC has now voided: `[M]`

| Date       | Records                                     |      Units | In `processed_units_daily` | Live (non-disappeared) |
| ---------- | ------------------------------------------- | ---------: | -------------------------: | ---------------------: |
| 2025-02-27 | M-118742 _(Inactive)_ + M-118746 _(Active)_ | 1,060 each |                      2,120 |                  1,060 |
| 2025-05-15 | M-128009 _(Inactive)_ + M-127913 _(Active)_ | 1,133 each |                      2,266 |                  1,133 |

`processed_units_daily` still holds the **doubled** figure. Since that column is the billing input, those
two months carry a **2,193-unit overstatement** sitting in the billing path. Unbilled today; it would
over-bill MRC if those months were ever invoiced. The processed bridge filters `disappeared_at IS NULL`
(`src/lib/mymrc/processed-bridge.ts:166`) `[D]`, so re-running it over those dates self-corrects downward.

---

## 6. On the undated-haul hypothesis — ⚠ THIS SECTION'S CONCLUSION IS WRONG

> **Superseded by ADR-0089 (2026-08-10). The undated hauls WERE a cause, not a cleared
> hypothesis.**
>
> The reasoning below runs "no date ⇒ pre-anchor ⇒ inert". Every step after the first is
> sound; the first is false. **"No docking date" is not "no delivery date."** These hauls
> are undated only on `Docking_Appointment_Date__c`, a SCHEDULING field populated only
> when a haul books a dock slot — and route collections never book one. They carry
> `Recycler_Reported_Delivery_Date__c`, which was in the same payload, was catalogued in
> our own 2026-07-22 discovery doc, and was measured by nobody: the re-measurement in §9's
> negative control corrected the JSON _path_ but still only ever looked at the appointment
> field. That omission is what produced this conclusion.
>
> 886 route-collection hauls were silently skipped by the ADR-0059 bridge, **35 of them
> post-anchor Delivered** (639 program + 1,790 non-program units, 133,595 lb), and never
> reached the floor. Read ADR-0089 for what is true.

The 2,301 undated inbound hauls are **real**, and the figure is confirmed: 2,301 `Delivered`+`General`
hauls with no docking date, carrying **190,616 units**. `[M]`

**But they are not why the floor is negative.** Every one of them was first seen on 2026-07-22 and
carries no date at all, meaning they are pre-anchor history. The 2026-07-22 physical count _resets_ the
ledger — `anchorFlowBounds()` excludes everything on or before the anchor's Pacific day `[D]` — so no
pre-07-22 record, dated or not, can move today's number. The negative is generated entirely inside the
07/23–07/29 window.

They remain a genuine and separate defect: they corrupt any pre-anchor historical reconciliation,
including the June workbook's 3,977-unit month-close oracle.

Two corrections to the numbers as handed over:

- Undated across the whole mirror is **3,296**, not 2,301. The 2,301 figure is the `Delivered`+`General`
  subset the bridge actually consumes — correct for that filter. `[M]`
- **Negative control:** my first measurement said _all 7,251_ rows were undated. That was a method
  artifact — the payload is a Salesforce UI-API shape and the date lives at
  `payload->'fields'->'Docking_Appointment_Date__c'->>'value'`, not at the top level. Enumerating the
  actual payload keys exposed it. Re-measured against both the real column and the correct JSON path,
  which agree exactly (3,955 dated by each). `[M]`

Also checked and cleared: **nothing in the inventory path reads `disappeared_at` on hauls.** The inbound
bridge deliberately does not filter it (`src/lib/mymrc/inbound-bridge.ts:14-19` documents why) `[D]`,
so the over-broad haul `markDisappeared` from ADR-0070 does not contribute to the negative.

---

## 7. The freshness guard shipped last night cannot catch this

`src/lib/mymrc/freshness.ts` was added in `552e21c` to catch exactly this class of silent freeze. It
measures the `hauls` feed on `docking_appointment_date` and documents: _"a healthy hauls feed therefore
reports a negative age and can never be stale. When the feed stops, the newest appointment recedes into
the past and crosses the threshold on its own."_ `[D]`

**That assumption does not hold here.** Measured right now: `[M]`

- `max(docking_appointment_date)` across the mirror = **2026-08-07** — in the future → guard reports **fresh**.
- That maximum comes from the 71 `Confirmed` rows, which _are_ still refreshing.
- The 7,174 `Delivered` rows are frozen at **2026-07-21**.

Because upcoming appointments and delivered history live in the same table and only the delivered half
is broken, the future-dated `Confirmed` rows hold the maximum permanently ahead of `now()`. The guard
will report the hauls feed healthy indefinitely, while the feed that actually drives inbound is dead.

**The guard is blind to the exact feed causing the negative.**

> **FIXED, in two steps.** 2026-07-31 (ADR-0070 Am.1): the guard was scoped to
> `status = 'Delivered'` rows only, so future-dated `Confirmed` appointments can no longer
> hold the maximum ahead of `now()`. 2026-08-10 (ADR-0089 D3): the column moved to
> `COALESCE(recycler_reported_delivery_date, docking_appointment_date)` — the same key the
> bridge aggregates on, which is the property that was actually missing. A guard that
> measures a different column than the bridge is not a guard.

---

## 8. The fix, ranked

> **ALL of the "stop the bleeding" items below are DONE as of 2026-08-10, and item 4's
> stated dependency was false.**
>
> 1. **DONE** — the July Woodland COR is unblocked and verified clear at **512 units EOM**.
> 2. **DONE** — executed as the ADR-0089 D4 recovery (re-detail 7,314/7,314 → delta report
>    → gated re-bridge). Actual result **+1,382**, against the ~+1,500 predicted here.
> 3. Not needed — no fresh physical count was required.
> 4. **DONE, and no MRC action was ever needed.** This item said the backfill "requires MRC
>    to populate `Docking_Appointment_Date__c`, or an agreed dated fallback" — that would
>    have parked the fix on a third party indefinitely. The hauls already carried
>    `Recycler_Reported_Delivery_Date__c`; the bridge now keys on COALESCE and the
>    re-bridge landed them.
> 5. **DONE** — see the §7 banner above.

### Stop the bleeding — today

1. **Do not prefill or finalize the July Woodland COR** until inbound is backfilled. It would file a
   negative inventory figure on a regulatory certificate. This is the only item with an outside-party
   consequence.
2. **Re-arm the `completed_hauls` backfill cursor and re-run it for 2026-07-22 → 2026-07-31**, then run
   the inbound bridge over the same window. Expected result: the floor returns to roughly **+1,500**
   (1,597 anchor + ~5,600 recovered inbound − 5,716 stripped). `[I]`
3. **If that cannot be done immediately, have Woodland take a fresh physical count.** A new anchor resets
   the ledger to reality in one step — that is precisely what the anchor mechanism exists for, and it
   unblocks the COR without waiting on the scraper.

### Correct the history

4. **Backfill the 2,301 undated Delivered hauls** (190,616 units). Requires MRC to populate
   `Docking_Appointment_Date__c`, or an agreed dated fallback. Until then, no pre-07-22 reconciliation
   is trustworthy — including the June 3,977 workbook comparison.
5. **Re-run the processed bridge over 2025-02-27 and 2025-05-15** to drop the duplicated 1,060 and 1,133
   units before either month is invoiced.

### Prevent recurrence

6. **Fix the hauls freshness measurement** (§7). Measure the newest _Delivered_ haul, or scope the
   freshness column by status — the current whole-table `max()` is permanently masked by future
   appointments. This is a one-line-class fix to a guard that just shipped and does not work.
7. **Make `onHand` refuse to render a one-sided ledger.** If the newest bridged inbound day trails the
   newest bridged processed day by more than a threshold, the tile should read _"intake feed N days
   stale"_ rather than a confident wrong number. A ledger that silently renders half its inputs is the
   underlying defect, and it is what turned a scraper bug into a week of invisible drift.
8. **Alert on a negative program pool** (ntfy, per ADR-0036/0037 — `high`, not urgent). It crossed zero
   on 07-24 and nothing said a word for seven days.

---

## Method

All figures measured 2026-07-30 evening PT against production
(`10.99.0.2` → `docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision`), read-only — no writes, no
schema changes, no application state touched. Code references are file:line against `main` @ `552e21c`.
Balance components were reproduced in SQL using the same windows `anchorFlowBounds()` derives
(`@db.Date` columns `> 2026-07-22`; `arrived_at >= 2026-07-23 07:00Z`).
