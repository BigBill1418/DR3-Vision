# Woodland's program floor is overstated by ~10,600 units — diagnosis

- **Date:** 2026-09-10, ~21:45 PT (container logs and Salesforce timestamps below are UTC; Pacific is given wherever a time matters)
- **Repo:** `main` @ `390d9a2`, tree clean
- **Method:** read-only against production (CHAD-HQ `10.99.0.2`, `dr3-vision-postgres`). **No writes, no restarts, no deploys.**
- **Decision record:** `docs/adr/0131-a-number-no-one-could-call-impossible.md`
- **Open items:** `docs/OPEN-ITEMS.md` § 0.BS

---

## The answer first

**Woodland's true program units on hand is approximately 390. Every surface in
the application is showing 11,020.** The floor is overstated by about **10,630
program units — a factor of 28** — and has been since **2026-09-04**.

**Nothing in this repository is broken.** The scrape, the ADR-0089 delivery-day
key, the ADR-0059 precedence guard, the ADR-0084 void filter and
`computeRunningBalance` all did exactly what their ADRs specify. Two rows in
MyMRC's own Salesforce org carry unit counts that cannot physically occur, and
there is no point anywhere in the chain that is allowed to say so.

**Eugene shows 0 program units on hand. That number is not wrong, and it is not
right — it is meaningless**, and nothing on the screen says which.

**Billing: no COR or invoice has ever been produced by this system** —
`cor_certificates` and `invoices` are both empty. The exposure is real but it is
upstream and forward, not filed. See § "Has this reached billing" below, which is
the section to read first if you only read one.

---

## 1. What each surface currently shows

`onHand(siteId, asOf)` (`src/lib/inventory/running-balance.ts:352`) is the single
computation. Reproduced in SQL against production tonight, as of 2026-09-10:

### Woodland (`de9875a3-a09f-484f-aed1-2891ef544b87`)

Anchor: the 2026-08-18 physical count, `measured`, 201 program / 722 non-program
/ 923 total. Flow windows per `anchorFlowBounds`: `@db.Date` columns
`> 2026-08-18`; `inbound_loads.arrived_at >= 2026-08-19 07:00:00Z`.

| Leg                                                                                     |    Program | Non-program |  Rows |
| --------------------------------------------------------------------------------------- | ---------: | ----------: | ----: |
| anchor (2026-08-18, measured)                                                           |        201 |         722 |     1 |
| **+** verified inbound                                                                  | **25,513** |       2,294 |    18 |
| **+** consumer drop-offs (`floor_public` 213, `floor_incentive` 10, `floor_illegal` 16) |        239 |           — |    26 |
| **−** stripped (`processed_units_daily`)                                                |   14,933.0 |     2,368.0 |    17 |
| **−** whole units sold (`outbound_materials`, `sub_category='renovation'`)              |          0 |           0 | **0** |
| **−** landfilled (`landfilled_units`)                                                   |          0 |           0 | **0** |
| **= displayed today**                                                                   | **11,020** |     **648** |       |

`201 + 25,513 + 239 − 14,933 = 11,020` · `722 + 2,294 − 2,368 = 648` · total **11,668**

`sites.max_units_indoor` for Woodland is **3,500**. The application has been
displaying a floor at **3.3× the building's capacity** for six days.

### Eugene (`e76bf5a3-b25f-4b10-888e-1b6656431fbe`)

| Leg                   | Program | Non-program |           Rows |
| --------------------- | ------: | ----------: | -------------: |
| anchor                |       0 |           0 | **none, ever** |
| everything else       |       0 |           0 |          **0** |
| **= displayed today** |   **0** |       **0** |                |

Eugene has **no physical snapshot, ever**, and **zero rows** in
`inbound_loads`, `processed_units_daily`, `consumer_dropoffs`,
`outbound_materials` and `landfilled_units`. It does not throw and it is not
negative — `resolveAnchorPair(null)` returns `{program: 0, nonProgram: 0}` and
`anchorFlowBounds(null)` returns epoch for both windows, so the balance is
`0 + (nothing since 1970) = 0`.

This is structurally expected — `src/lib/mymrc/inbound-bridge.ts` records that
Eugene has no haul-mirror rows because ADR-0057 C-21 Switch-Account was never
built, and ADR-0088 notes Eugene has no machine. **But "not yet onboarded"
and "zero mattresses on the floor" render identically**, at
`text-5xl font-bold` on the operator iPad hub
(`src/app/operator/[site]/today/page.tsx:161`) and as a bare `0` on the
multi-site dashboard. The one tell — `anchorPool: 'legacy'` — drives an amber
badge on the floor tile only; `OpsOverviewPanel` and `dashboard/page.tsx` read
the same object and ignore it.

---

## 2. Four claims checked, three of them falsified

The four things that jumped out of the snapshot table at first look. Three are
not defects. Establishing that matters as much as finding the real one, because
each is a place a future session would otherwise spend a day.

### 2a. "Two rows at the byte-identical `snapshot_at` for 2026-08-18" — **FALSIFIED. Working exactly as designed.**

The `legacy` row **is voided**, and the audit log tells the whole story:

```
6f8ae03b… insert  actor c6a6ca68 (Bill)  2026-08-19 14:55:42
          {"pool_attribution":"legacy","physical_total":923,"computed_total":"540","reconciled_delta":383}

6f8ae03b… update  system:eod-count-split-20260819  2026-08-19 16:59:40
          {"voided_at":"now","reason":"superseded by the FINAL measured count for the same EOD-8/18
           moment: 923 total = 201 program + 722 non-program (Bill, 2026-08-19 ~9:58 AM PT)"}

855a23b1… insert  actor c6a6ca68 (Bill)  2026-08-19 16:59:40
          {"pool_attribution":"measured","program_units":201,"non_program_units":722,
           "physical_total":923,"computed_total":"721","reconciled_delta":202}

6f8ae03b… update  system:eod-count-split-20260819  2026-08-19 17:00:05
          {"corrected_to":"855a23b1-…"}
```

One count, entered unsplit at 7:55 AM PT, superseded 64 minutes later by the same
count with Bill's 201/722 split, the first row soft-voided per ADR-0084 with a
chain link recorded. `INV-ANCHOR-UNIQUE` (non-voided duplicates on
`(site_id, snapshot_at)`) returns **0 rows**. This is ADR-0084 and ADR-0078 D1
working precisely as written. **Do not void or repair anything here.**

### 2b. "`reconciled_delta` equals the entire count on 06-30 and 07-22, so computed was 0" — **FALSIFIED. An artefact of insert ordering.**

- **07-22** (`55654cd7`) _was_ written by `reconcilePhysicalCount`; its audit row
  records `computed_total: "0"`. Correct at the time: it was inserted
  **2026-07-22 21:18 UTC**, and at that instant there was **no prior anchor and
  no flow data loaded**, so `anchor === null` → epoch windows → a sum over an
  empty database. Zero was the right answer to the question asked.
- **06-30** (`a07707ed`) was **not** written by `reconcilePhysicalCount` at all.
  Its audit row has no `computed_total` field and carries a `note`:
  _"June 2026 close baseline (Rick signed ledger, ADR-0048 corrected 3748 program
  / 229 non-program = 3977). Historical anchor; does not supersede the live 07-22
  physical count."_ It was inserted by hand **two hours after** the 07-22 row
  (23:28 UTC), with `reconciled_delta` set literally equal to the total.

Neither row is evidence that a flow leg was failing to find its rows. **No
repair needed.**

### 2c. "The newest anchor is 23 days old, and `units_in_processing` is 0 everywhere" — **CONFIRMED, and it is a contributing condition.**

24 days as of tonight. It is not the cause of the overstatement — the anchor is
`measured` and correct — but it is what removed the last chance to catch it. A
physical count on any day after 2026-09-04 would have produced a
`reconciled_delta` of roughly **−10,600** and tripped the 20% swing guardrail
(`inventory_anchor_config.swing_threshold_pct = 20.00` at both sites) instantly.
`units_in_processing = 0` on every row is consistent — no row has ever used it.

### 2d. "The whole-units-sold and landfilled legs are zero" — **CONFIRMED, and structurally so.**

`outbound_materials` and `landfilled_units` hold **zero rows for Woodland, ever**.
Two of the five subtraction legs have never subtracted anything. In the current
23-day window that is _not_ the cause — but it is a permanent upward bias in the
ledger and it means the balance can only be corrected downward by `stripped`.
Related and open: ADR-0104, _"every outbound load is recorded and not one has a
weight."_

---

## 3. The defective leg, with the proof

### The leg: verified inbound. The rows: two, and only two.

18 inbound rows in the window, each a per-day aggregate written by the ADR-0059
bridge (`load_source_type='mymrc_haul'`, `count_mode='total'`, `arrived_at` at
Pacific midnight). Their unit counts:

```
08-19 1037   08-20  997   08-21 1103   08-24 1162   08-25 1037   08-26 1094
08-27 1133   08-28 1085   08-29  403   08-31  841   09-01 1355   09-02 1205
09-03  960   09-04 6547 ←  09-05  102   09-08  845   09-09 5989 ←  09-10  912
```

Cross-check against the independent per-haul (`status='submitted'`) population
for the same days:

| Day            | per-haul rows | per-haul total | day-aggregate |    ratio |
| -------------- | ------------: | -------------: | ------------: | -------: |
| 2026-09-01     |            11 |          1,278 |         1,355 |     1.06 |
| 2026-09-02     |             8 |          1,019 |         1,205 |     1.18 |
| 2026-09-03     |             6 |            731 |           960 |     1.31 |
| **2026-09-04** |             7 |        **697** |     **6,547** | **9.39** |
| 2026-09-05     |             1 |            102 |           102 |     1.00 |
| 2026-09-08     |             6 |            654 |           845 |     1.29 |
| **2026-09-09** |            10 |      **1,176** |     **5,989** | **5.09** |
| 2026-09-10     |             7 |            886 |           912 |     1.03 |

### Down to the individual haul

`mymrc_hauls_mirror`, `status='Delivered'`, `type='General'` — **6,551 rows**:

```
units bucket      rows    min    max
0–198            6,531      0    198
204–342             16    204    342
4840–6020            2   4840   6020   ←
```

Exactly two rows in the entire mirror exceed 350 units:

| Haul         | Delivery day |   `units` | `Recycler_Weight__c` | Container   | Transporter                  | Collection site        |
| ------------ | ------------ | --------: | -------------------: | ----------- | ---------------------------- | ---------------------- |
| **H-138391** | 2026-09-04   | **6,020** |           331,100 lb | 53' Trailer | Ron Lawrence & Son           | Kiefer Landfill        |
| **H-139774** | 2026-09-09   | **4,840** |           266,200 lb | 53' Trailer | Titan Concepts International | Costco-Innovel-Benicia |

A 53' trailer at Woodland since 2026-06-01 averages **114** units (n=468, median
**113**, range 27–209). 331,100 lb is **165 tons** on a trailer whose legal gross
combination weight is about 40.

### The weight cannot catch it, because the weight is derived from the units

Every row in the mirror satisfies `weight_lbs = units × 55` exactly — 140→7,700,
134→7,370, 128→7,040, and 6,020→331,100, 4,840→266,200. `Recycler_Weight__c` is
MyMRC's own `units × 55 lb` derivation, not an independent scale reading. **It
carries no information the unit count does not already carry, and it therefore
cannot cross-check it.** Anything built on the assumption that weight validates
count is building on the same number twice.

### The bad value is in MyMRC, not in this repo

The raw scraped payload of H-138391, verbatim from
`mymrc_hauls_mirror.payload`:

```json
"Recycler_Program_Unit_Count__c": { "value": 6020 },
"Unit_Count_at_Unload__c":        { "value": 6020 },
"Recycler_Weight__c":             { "value": 331100 },
"Container_Type__c":              { "value": "53’ Trailer" },
"Recycler_Reported_Delivery_Date__c": { "value": "2026-09-04" },
"Docking_Appointment_Date__c":        { "value": "2026-09-04" }
```

`apiName: "Haul_Request__c"`. Salesforce's `systemModstamp` on the linked account
record is `2026-09-08T15:49:44.000Z`, which matches the `updated_at` on the
bridged aggregate row (2026-09-08 18:01 — the hourly scrape that picked the
change up). **The 6,020 was entered into MyMRC, by a person, some time before
2026-09-08.** DR3-Vision mirrored it faithfully and bridged it correctly.

Note also that `recycler_name` on both rows is **`DR3 Woodland`** — in MyMRC's
model, the "recycler" reporting this count _is DR3_. This is DR3's own reported
figure sitting in MRC's system of record, not a third party's.

---

## 4. The true number, with the working

Two estimates, because the honest answer is a range and I will not collapse it.

**Lower bound — the two hauls contributed nothing.** Excluding H-138391 and
H-139774 entirely, the mirror sums to **14,653** program / 2,294 non-program over
161 hauls (and `25,513 − 14,653 = 10,860 = 6,020 + 4,840`, which confirms the two
rows are the whole of the discrepancy):

```
program    = 201 + 14,653 + 239 − 14,933 − 0 − 0 =   160
nonProgram = 722 +  2,294        −  2,368 − 0 − 0 =   648
total                                              =   808
```

**Point estimate — the two hauls were ordinary 53' loads.** Substituting the
median 53' trailer load (**113 units**, n=468 since 2026-06-01):

```
program    = 160 + (2 × 113) =   386
nonProgram =                     648
total                        = 1,034
```

> **These are ESTIMATES.** The lower bound is exact arithmetic on a stated
> assumption (the hauls delivered nothing, which is certainly false). The point
> estimate substitutes a population median for two values whose true magnitude
> only MyMRC or the Woodland dock knows. The true program figure is **between 160
> and roughly 420**; **~390 is the best single number**, and it should not be
> quoted to more than two significant figures.

### Why the corrected figure is credible

| Check                       | Reading                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| vs. building capacity       | 1,034 against `max_units_indoor` 3,500 — comfortable. The displayed 11,668 is 3.3× capacity.                                 |
| vs. the last physical count | 923 counted on 2026-08-18; ~1,034 twenty-three days later.                                                                   |
| net flow over the window    | in 17,412 (14,879 program-side + 2,294 non-program + 239 drop-offs), out 17,301 (14,933 + 2,368). **Net +111 over 23 days.** |

That last line is the strongest corroboration available: with the two hauls
removed, Woodland's floor is at **steady state** — a facility taking in and
stripping roughly 1,000 units a day and holding its level. That is what a
recycling plant running at capacity looks like, and it is not a shape you can
arrive at by accident from a wrong correction.

The residual ~111-unit drift is also consistent with the independent
`c5_conservation` finding of 2026-09-04 (`maxProcessable` 878 vs
`programProcessed` 957 — a ~79/day over-processing signal). **That residual is a
real, separate, open defect in the ~100-unit range.** It is not this one, and
fixing this one will make it visible again rather than resolving it.

---

## 5. Is this a recurrence?

**Same leg, third time. Different defect class each time. And this one is not a
defect in this repository.**

| Date                     | Defect                                                                                             | Class                    | Effect                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| 2026-07-30               | The `completed_hauls` backfill cursor drained; the inbound feed stopped while stripping continued. | feed **stopped**         | floor → **−3,969**                                          |
| 2026-08-10 (ADR-0089)    | Inbound keyed on `Docking_Appointment_Date__c`, a scheduling field null on every collection haul.  | feed **mis-keyed**       | 2,429 post-anchor units never landed; floor −1,671 → +1,382 |
| **2026-09-10 (tonight)** | MyMRC holds two physically impossible unit counts. Every component behaves correctly.              | feed carries **garbage** | floor → **+11,020**, ~28×                                   |

The first two were DR3-Vision bugs and both were properly fixed. Both fixes
hardened the **transport** of the inbound leg — that it arrives, and that it is
keyed correctly. **Neither asserted anything about whether what arrives is
possible**, and that is the unclosed gap. This is not the same defect returning
and it is not an unfinished migration; it is the third distinct failure mode of
the one leg that has failed three times, and it is the first one that no amount
of correctness in this codebase would have prevented.

### The check that should have caught it was silenced by it

`c5_conservation` (`src/lib/audit/leg-fetchers.ts:932`) asks whether more units
were processed than could possibly have been on hand. It had been firing
`critical` on Woodland for six weeks:

```
2026-08-05  maxProcessable   -132   nonProgramProcessed     79   resolved
2026-08-08  maxProcessable   -349   programProcessed     1,000   resolved
2026-08-12  maxProcessable    991   programProcessed     1,024   resolved
2026-08-14  maxProcessable    743   programProcessed       787   resolved
2026-09-04  maxProcessable    878   programProcessed       957   OPEN   ← the last one ever
```

The sweep has run daily since and produced nothing. `maxProcessable` is derived
from inbound, and 10,860 phantom units bought six weeks of headroom in one
stroke. **The check did not fail — it was satisfied, by the defect.** A
conservation check is one-sided: it sees too much going out and is blind to too
much coming in, and too much coming in is exactly what makes too much going out
look legal. This is the single most important sentence in this document for
anyone designing the fix.

### Nothing else alerted either

- `equipment_throughput_gap_alerts` fired on 09-01, 09-03, 09-04 and 09-08 —
  ADR-0088 machine-throughput gaps, unrelated.
- `alert_cooldowns` holds two rows, neither about inventory.
- `c6_inventory_continuity` last fired 2026-08-20 (computedEnd 324 vs physical
  923 — the 08-18 count), resolved.
- The ADR-0078 anchor swing guardrail only evaluates at physical-count time.
  There has been no count since 2026-08-18.

**Six days, a 28× error, an impossible number on every operator iPad, and not one
page.**

---

## 6. Has this reached billing?

**Read this section even if you skip the rest.**

### Nothing has been filed by this system

- **`cor_certificates`: 0 rows.** No COR has ever been generated, drafted,
  finalized or rendered by DR3-Vision.
- **`invoices`: 0 rows.**

So the literal answer to "has a wrong program number been filed on a COR" is
**no** — not through this application.

### But the phantom units are in MRC's system of record right now

The 6,020 and the 4,840 are not artefacts of DR3-Vision's copy. They are the
values of `Recycler_Program_Unit_Count__c` in MyMRC's Salesforce org, attributed
to recycler **DR3 Woodland**, on two Delivered hauls. **10,860 phantom program
units sit in MRC's own September record for Woodland**, and MRC bills on program
units. DR3-Vision cannot have caused this and cannot correct it. **This needs a
human at MRC, and it is the most urgent item in this document.**

### And the forward exposure inside this repo is live

If a September COR is generated after month-end from the current ledger:

1. `computeCorPrefill` (`src/lib/cor/prefill.ts:214`) calls `onHand` and takes
   `balance.total.toNearest(1)`.
2. The **only** numeric gate is `assertCorInventoryNotNegative`. There is **no
   upper bound**, and nothing compares the figure to `sites.max_units_indoor`.
3. That number is written to `cor_certificates.inventory_units`, with the
   program/non-program split preserved in the `inventory_source` JSON.
4. It is printed at `src/app/internal/cor-pdf/[id]/page.tsx:153` as
   _"Unprocessed inventory at month close: N units"_ — the Exhibit 5 Rick signs
   and submits to MRC.

On today's ledger that prints **~11,700 units** for a 3,500-unit building.

**A second, independent COR exposure exists at Eugene** and it is arguably worse:
`computeCorPrefill` does not require an anchor at all. With none — Eugene's exact
state — `onHand` returns the sum of every flow row since **1970**, `inventory_source`
faithfully records `anchorSnapshotId: null`, and **nothing refuses**. Eugene's
flow tables are empty today so the figure would be 0; the moment Eugene's data
starts arriving without a physical count first, that path files an unanchored
number on a signed regulatory document.

### One separate billing item, found while auditing

The 2026-07-30 negative-inventory diagnosis (§ billing, item 5) measured a
**2,193-unit overstatement in the billing path**: two MRC-voided duplicate
processed records double-counted into `processed_units_daily`.
`stripped_program` is the MRC billing input
(`src/lib/invoices/generation-inputs.ts:124`). The remedy was named — re-run the
processed bridge over those two dates; it filters `disappeared_at IS NULL` and
self-corrects downward.

**Both rows are still in production tonight:**

| `production_date` | `stripped_program` | should be | `created_at`        | `updated_at`        |
| ----------------- | -----------------: | --------: | ------------------- | ------------------- |
| 2025-02-27        |        **2,120.0** |     1,060 | 2026-07-24 00:13:37 | 2026-07-24 00:13:37 |
| 2025-05-15        |        **2,266.0** |     1,133 | 2026-07-24 00:13:37 | 2026-07-24 00:13:37 |

`created_at = updated_at` — they have never been rewritten. Forty-two days, a
documented defect, a documented one-command remedy, and nothing ran it. Those
months were billed on paper outside this system, so whether DR3 was actually
overpaid is a question for MRC's records; but any reconciliation or invoice
generated from these rows reproduces the overstatement.

---

## 7. What to repair — specification only, nothing executed

**Nothing below was performed.** Read-only session. Ordered by urgency.

### R1 — Correct MyMRC. _Operator action, blocking, urgent._

H-138391 (2026-09-04) and H-139774 (2026-09-09) carry
`Recycler_Program_Unit_Count__c` / `Unit_Count_at_Unload__c` values of 6,020 and
4,840. Establish the true counts from the dock paperwork or the BOLs and have
them corrected **in MyMRC**. Once corrected, the hourly scrape re-details the
rows, the bridge rewrites the day aggregates (it SETs absolute values, never
increments — re-running is idempotent by design), and the floor self-heals with
no code change and no database write. **This is the whole fix**, and it belongs
to a person at MRC or in the Woodland office, not to Aegis.

Do **not** hand-edit `mymrc_hauls_mirror` or `inbound_loads`. The mirror is a
copy; the next scrape overwrites it, and ADR-0084's standing rule —
_"do not edit the mirror"_ — exists for this.

### R2 — Do not file a COR for Woodland for September until R1 lands.

The number is wrong by ~10,600 and the COR path has no upper-bound gate.

### R3 — Take a physical count at Woodland. _Operator action._

The anchor is 24 days old. A count now re-anchors the ledger, produces a
`reconciled_delta` that measures exactly how wrong the ledger was, and trips the
20% swing guardrail as designed. If R1 is still outstanding, the count is
_additionally_ valuable: it corrects the floor independently of MyMRC.

### R4 — Re-run the processed bridge over 2025-02-27 and 2025-05-15. _Aegis._

The remedy named in the 2026-07-30 diagnosis, never executed. The bridge filters
`disappeared_at IS NULL`, so re-running over those dates rewrites 2,120.0 → 1,060
and 2,266.0 → 1,133 by its own normal path. Audited by the bridge's existing
`audit_log` write. **No hand-written UPDATE.** Verify afterwards that
`updated_at` has moved on both rows — that is the check ADR-0102 taught us to run.

### R5 — Build the ADR-0131 harness. _Aegis._

Seed set and tier assignments in ADR-0131 D8. `INV-INBOUND-PLAUSIBLE` (threshold 350) and `INV-FLOOR-WITHIN-CAPACITY` are the two that catch this class.

### R6 — Decide what Eugene's inventory surfaces should say. _Bill._

Today they say `0`. The options are to keep rendering 0, to render "—" with an
explanation when there has never been an anchor, or to refuse the tile outright.
This is a product decision, not a bug. `INV-COR-HAS-ANCHOR` (ADR-0131 D8 #10)
closes the regulatory half regardless of which way it goes.

---

## Appendix — what was NOT wrong

Recorded so no future session re-derives it.

| Checked                                                                          | Result                                                                                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The 2026-08-18 duplicate anchor                                                  | Correct. ADR-0084 void + ADR-0078 chain, working as designed.                                                                                |
| `reconciled_delta` = full count on 06-30 / 07-22                                 | Insert ordering, not a broken leg.                                                                                                           |
| Anchor pool split sums to physical total                                         | 0 violations.                                                                                                                                |
| Anchors stamped at Pacific midnight                                              | 4/4 at 07:00:00Z.                                                                                                                            |
| Non-voided duplicate anchors                                                     | 0.                                                                                                                                           |
| Snapshots with both `units_indoor` and `units_total`                             | 0.                                                                                                                                           |
| Verified inbound rows where program + non-program ≠ total                        | 0.                                                                                                                                           |
| `workbook_sources.folder_path` brace token                                       | 1/1.                                                                                                                                         |
| Dateless Delivered hauls (ADR-0089 D4's claim)                                   | **0 / 6,551 — the claim holds.**                                                                                                             |
| Stale aggregate rows orphaned from their mirror day-group (ADR-0089 §5 residual) | **0 rows — holds.**                                                                                                                          |
| `inventory_count_holds`                                                          | Empty.                                                                                                                                       |
| Void status/column consistency across `inbound_loads`                            | Consistent — 2 voided rows, both `status='voided'` and `voided_at` set.                                                                      |
| The 2026-07-29 671-unit `ipad_floor`/`mymrc_haul` slot contention (ADR-0089 §5)  | Now **pre-anchor and inert** — the 2026-08-18 anchor supersedes it. The OPEN-ITEMS warning not to publish the −52 program floor is obsolete. |

### Open, and not caused by tonight's defect

1. **`src/lib/audit/leg-fetchers.ts:456` (`startBalance`) is a second database
   implementation of `onHand`** — its own anchor query without the ADR-0078
   `created_at` tiebreak, and a bare drop-off sum that silently absorbs an
   untaught kind where `onHand` throws. ADR-0037 D6's stated premise is "ONE
   shared function … never two competing sums."
2. **Three anchor selectors lack the ADR-0078 `created_at` tiebreak** —
   `startBalance`, `cor/prefill.ts:215` and `loads/eod-inventory.ts:440`. ADR-0084
   recorded this deliberately deferred. **`cor/prefill.ts` is the COR filing
   path**: on a two-count day the COR can name a different anchor row than the
   figure was computed from.
3. **Seven surfaces render an unclamped on-hand**, including two that consume
   the very `FloorInventoryTileData` whose `negative` flag exists to suppress it
   (`OpsOverviewPanel.tsx:145`, `dashboard/page.tsx:248`). None has an upper
   bound either — which is why 11,020 rendered without comment.
4. **894 open `audit_findings`** (381 `c1_inbound`, 361 `c3_outbound`) with no
   triage path.
5. **`outbound_materials` and `landfilled_units` have never held a Woodland row** —
   two of five subtraction legs permanently inert (related: ADR-0104).
6. **The ~79/day `c5_conservation` residual**, real and separate, currently masked.
