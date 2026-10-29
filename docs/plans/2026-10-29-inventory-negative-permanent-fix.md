# Plan — negative inventory, permanently (ADR-0143)

- **Status:** IN BUILD 2026-10-29 (Pacific). Bill answered B1–B5 (ADR-0143 § Bill's decisions). Items 1–6 built
  on branch `fix/adr0143-negative-inventory` (Mercer), not deployed; item 7 partly; item 8 script written, not run.
  See §8.
- **ADR:** `docs/adr/0143-the-program-pool-is-a-claim-not-a-count.md`. The diagnosis, evidence and root causes
  RC1–RC5 live there and are not repeated here.
- **Evidence query:** `docs/queries/2026-10-29-inventory-pool-diagnosis.sql` (read-only; run 2026-10-29 and
  verified to execute).
- **Register:** `docs/OPEN-ITEMS.md` § 0.CH.

## 1. Definition of done

1. No surface, mail or export prints a negative pool. A CI test proves it by scanning the code (§4 T1).
2. A write that drives any pool below zero opens an `inventory_exceptions` row **inside the same transaction**,
   and Bill gets one `high` ntfy within one sync tick (≤ 10 min for the workbook, ≤ 1 h for the MyMRC bridge).
3. `inventory_position_daily` cannot hold a negative `closing` without an exception id. The database refuses it,
   and a migration test proves the refusal.
4. A pool-split error can be corrected without a physical count, by a four-eyes adjustment row that preserves
   the total.
5. Woodland's −247 is resolved by a Bill-approved repair (§5), and the program pool reads ≥ 0 on every surface.
6. 30 consecutive days with no new exception opened at Woodland after the convention decision (B2/B3) is in
   force. This is the "it does not come back" proof, and Ryan grades it.

## 2. Every writer of an inventory leg

On-hand is not a stored counter. It is derived on every read from six tables by one function,
`computePoolBalance` (`src/lib/inventory/running-balance.ts:399`). That is the right design: there is no
counter to race, and no decrement to guard. The question for each writer is therefore not "is the decrement
atomic", but "**does anything look at the pools after this write?**"

| Leg (table)                                        | Writers (`origin/main` 3573f74)                                                                                                     | Txn / idempotent / site-scoped                                                     | Looks at pools after write?                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Anchor (`site_inventory_snapshots`)                | `reconcilePhysicalCount`, `correct-count.ts`, `void-count.ts`, workbook-promotion                                                   | Yes (ADR-0072 tiers, ADR-0084 void, ADR-0118 one event)                            | Swing % vs prior only. **Pools no**                                                                      |
| Inbound (`inbound_loads`)                          | `mymrc/inbound-bridge.ts` (ON CONFLICT … WHERE `mymrc_haul`), `bulk-inbound.ts`, `verify-gate.ts`, `floor-inbound.ts`, load-service | Yes (ADR-0060 D5 / ADR-0142 one source per day; `assertSplit` program+non = total) | **No**                                                                                                   |
| Drop-offs (`consumer_dropoffs`)                    | `dropoffs/service.ts`, `dropoffs/floor-dropoff.ts`                                                                                  | Yes (offline-queue idempotency, ADR-0078)                                          | **No**                                                                                                   |
| Stripped (`processed_units_daily`)                 | `workbook-sync/upsert.ts` (Woodland's real path), `mymrc/processed-bridge.ts`, `loads/processed-units.ts`                           | Yes (ADR-0119/0123 ownership guards on the statement)                              | **Only `closeProcessedUnitsDay` (`processed-units.ts:308`), and Woodland closed 0 of 33 days in Vision** |
| Whole units sold (`outbound_materials` renovation) | `loads/outbound.ts`                                                                                                                 | Yes                                                                                | **No**                                                                                                   |
| Landfilled (`landfilled_units`)                    | `loads/landfilled.ts`                                                                                                               | Yes                                                                                | **No**                                                                                                   |

What the table shows: concurrency, idempotency and site isolation were all hardened over ADR-0078/0118/0119/
0120/0123, and none of those is the cause today. Every path can push a pool below zero, because the only
post-write check sits on a door Woodland does not use. Replaying an offline queue twice is guarded by
idempotency. A backdated MyMRC correction lands through the 45-day bridge window (OPEN-ITEMS 0.CA). It moves
the pools, and today nothing notices that it did. That gap is what D2 closes.

## 3. Work breakdown

Owners: **Mercer** = `svdp-apps-engineer` (builds; Aegis if Mercer is unavailable). **Ryan** = independent
verification (read-only). **Jesse** = visibility check. **Bill** = decisions and the repair approval.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                   | Owner         | Depends on | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | ------ |
| 0   | Bill answers B1–B6 (§6), one at a time.                                                                                                                                                                                                                                                                                                                                | Bill          | —          | 20 min |
| 1   | **D1 presenter + the two raw surfaces + COR pool guard.** `presentOnHand()` in `negative-floor.ts`. Replace raw rendering at `loads-inventory/page.tsx:95-97` and `operator/[site]/today/page.tsx:161-164`. `assertCorInventoryNotNegative` checks program and non-program. Tests T1, T2, T3.                                                                          | Mercer        | —          | 0.5 d  |
| 2   | **D5 remedy text, part 1.** `INV-POOL-NON-NEGATIVE` and `INV-ANCHOR-FRESH` remedies take their wording from `classifyNegativeFloor`, so the remedy no longer contradicts the tile. Test T4.                                                                                                                                                                            | Mercer        | B4         | 0.25 d |
| 3   | **D3 migration.** `inventory_exceptions`, `inventory_pool_adjustments` (CHECK `from_pool <> to_pool`, `units > 0`, approver ≠ proposer), `inventory_position_daily` plus a deferrable constraint trigger: `closing >= 0 OR exception_id IS NOT NULL`. Test T5.                                                                                                         | Mercer        | B5         | 1 d    |
| 4   | **Sixth leg.** `computePoolBalance` adds approved adjustments (+ to_pool / − from_pool). The ADR-0110 D2 equivalence pin and `leg-fetchers` go through the same function, so there is still ONE computation. Tests T6, T7.                                                                                                                                             | Mercer        | 3          | 0.5 d  |
| 5   | **D2 post-write check.** `assertPoolsAfterWrite(tx, site, day, writer)` inside every writer in §2, under `lockSiteAgainstPromotion`. It opens an exception on a ≥0 → <0 transition (one open exception per site+pool) and rebuilds `inventory_position_daily` from the first affected day. Tests T8–T11.                                                               | Mercer        | 3, 4       | 1.5 d  |
| 6   | **D5 alerting, part 2.** Onset `high` page on `dr3-vision-system` via the existing `publishNtfy` and `alert_cooldowns` (key `inventory-exception:<id>`). A 7-day re-page. A daily-digest line while open. In-app exception page `/dashboard/<site>/inventory-exceptions/<id>` with the legs table and a "propose adjustment" action. Pilot per hard rule 12. Test T12. | Mercer        | 5          | 1 d    |
| 7   | **D6 split convention.** Write Bill's B2/B3 rule into the Woodland workbook instructions and the Vision daily close (`processed-units-close`). If B3 = "measured", the close asks for the split explicitly and shows the program available before it is accepted.                                                                                                      | Mercer + Bill | B2, B3     | 0.5 d  |
| 8   | **Repair Woodland −247** (§5). Mercer proposes the row; Bill approves in-app. Not run before item 4 exists.                                                                                                                                                                                                                                                            | Mercer → Bill | 4, B6      | 0.25 d |
| 9   | **Verify.** Live SHA = merged SHA. Mutation-test that the presenter scan goes red. Fire one exception on staging and read the message back off ntfy. Recompute both sites against this plan's query. Reconcile items 1–8 DELIVERED / PARTIAL / NOT STARTED.                                                                                                            | Ryan          | 1–8        | 0.5 d  |
| 10  | **Visibility.** The exception table, the onset page and the digest line show up in the five-signal check. `COVERAGE.md` row updated.                                                                                                                                                                                                                                   | Jesse         | 6          | 0.25 d |
| 11  | **30-day hold** (DoD 6). Ryan re-runs §4 of the evidence query weekly. Close 0.CH only on a clean 30 days.                                                                                                                                                                                                                                                             | Ryan          | 7, 8       | —      |

Deploy note: items 1, 3–6 touch `src/`, so the deployer rebuilds and the dock iPads get a new shell. Tell Bill
before each push, so he can clear the dock. Batch items 1–6 into one deploy if possible. Item 2 can ride item 1.

## 4. Tests that would have caught each cause

| Test | Catches                                                                                                           | Shape                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | RC3: a raw pool rendered outside the presenter                                                                    | Repo scan, `src/app/**`, mail modules. Asserts the inspected count > 0. A planted `balance.program.toString()` in a fixture page turns it red.                                 |
| T2   | RC3: loads-inventory and today render −247                                                                        | Render with `onHand` mocked to `{program:-247, nonProgram:644, total:397}`. Assert "-247" is absent and the Am.1 case-1 sentence is present.                                   |
| T3   | RC3: COR passes on a negative program pool                                                                        | `prefill` with total +397, program −247 → `CorLedgerNegativeError`.                                                                                                            |
| T4   | RC4: remedy disagreement                                                                                          | For each `classifyNegativeFloor` case, the invariant remedy string and the tile sentence come from the same function (identity, not equality of copies).                       |
| T5   | D3: a silent negative                                                                                             | DB test (`*.db.test.ts`): insert `inventory_position_daily` with `closing = -1` and no exception → the trigger raises; with an exception id → accepted.                        |
| T6   | D4: adjustment changes the total                                                                                  | Adjustment rows move pools by ±units, total unchanged to the unit (Decimal). `from_pool = to_pool` is refused by the CHECK.                                                    |
| T7   | One computation (ADR-0037 D6)                                                                                     | Extend `eod-onhand-equivalence.test.ts` and the leg-fetchers parity test with an adjustment present.                                                                           |
| T8   | RC2: workbook sync writes a split that drives program < 0                                                         | The Woodland 09-17 day replayed (anchor 128, intake 769/216 + 14 drop-offs, stripped 1,172/0 after 09-15/16) → exception opened, writer `workbook-sync`, first-negative 09-17. |
| T9   | RC2: same through the MyMRC processed bridge, and through a backdated correction landing inside the 45-day window | As T8, with `production_date` 20 days back.                                                                                                                                    |
| T10  | Idempotency: replaying the same write does not open a second exception                                            | Run T8 twice → one exception.                                                                                                                                                  |
| T11  | Concurrency: two writers on one site                                                                              | Two transactions under `lockSiteAgainstPromotion` → serialised, one exception. Precondition stated in the test name: it does not pre-create the negative state.                |
| T12  | D5: page once, not daily                                                                                          | A run on days 1–6 open → 1 publish. Day 7 → 1 re-page. Resolved → none.                                                                                                        |

## 5. Repair of the existing Woodland −247 (proposed; NOT run)

Facts `[M]`: total 397 (positive and plausible); program −247; non-program +644. The 09-15 → 10-08 window shows
1,033 non-program delivered and 248 non-program processed on 2 of 19 days.

Two options. Bill picks (B6):

- **R-A (recommended if the floor is physically segregated):** a physical count at Woodland **with the split
  counted, not estimated**, entered through the normal count path (ADR-0072 tiers apply).
  - It resets both pools to measurement.
  - It also clears `INV-ANCHOR-FRESH` (the anchor is 45 days old).
  - The count's `reconciled_delta` records the drift. Because the cause is documented here, the invariant's
    "a count would hide it" objection does not apply.
- **R-B (if the split cannot be counted):** after item 4 ships, one `inventory_pool_adjustments` row:
  `site=woodland, day=2026-10-08, from_pool=non_program, to_pool=program, units=247`,
  reason "ADR-0143: non-program processed as program, 09-15..10-08 (17/19 days np=0)". Proposed by Mercer,
  approved by Bill.
  - Program 0, non-program 397, total 397 unchanged.
  - Dated 10-08, the last day the residue moved, so the position history is honest from then on.
  - Caveat: program 0 is the _least_ adjustment, not a measurement. Bill may choose a larger figure; the total
    cannot move either way.

Do **not** clamp the pool, edit `processed_units_daily` (the workbook sync and the MyMRC bridge would rewrite
it, and they are MRC's record), or void the 09-14 count.

## 6. Decisions for Bill (one at a time, recommendation first)

- **B1 — Do the program / non-program floor pools matter?** _Recommended: yes, keep both._ MRC pays on program
  units, and a program pool that goes negative is the only signal Vision has that more program processing was
  reported than program intake. The alternative is total-only on-hand, which would make the negatives
  disappear by definition.
- **B2 — May a unit received as non-program be processed and reported to MRC as program?** _Recommended: ask
  Rick / the MRC contract owner before anything else._ If not, September's 17 zero-non-program days are a
  reporting error that MyMRC also carries (ADR-0143 finding 2), and it may need an MRC correction. If yes, the
  pools should be tracked as one, and B1 flips.
- **B3 — Is program stock physically separate on the Woodland floor, so a count can measure the split?**
  _Recommended: find out from Juan/Rick._ This decides R-A vs R-B and whether the daily close asks for a
  measured split.
- **B4 — Who acts on a negative-pool exception?** _Recommended: the site manager in-app (Woodland ops), Bill
  paged once on onset, and re-paged at 7 days._
- **B5 — Approve the three new tables and the trigger (D3/D4)?** _Recommended: yes._ This is the only design that
  makes "no unexplained negative" a database fact without refusing MRC data.
- **B6 — Repair: R-A count with a measured split, or R-B adjustment of 247?** _Recommended: R-A if B3 = yes,
  otherwise R-B._

Also open, not blocking: a count cadence owner for both sites (`INV-ANCHOR-FRESH` has paged daily and nobody
counted). Eugene has no flow feed at all, so its 751 is a constant; a feed for Eugene is a separate item.

## 7. Monitor (graded, ADR-0036/0037)

- **Topic `dr3-vision-system`** (existing, Bill only). Title
  `[DR3-Vision] Woodland program inventory went negative (−N) — <cause>`.
  - Click: tier-1 `https://dr3-vision.svdp.us/dashboard/woodland/inventory-exceptions/<id>`.
  - Tags `warning,inventory,dr3`.
  - Priority `high` on onset; one `high` re-page at 7 days open; otherwise a digest line.
- **5-question gate:**
  - q1 actionable in 5 min: yes, approve or reject the proposed adjustment on the exception page.
  - q2 customer-visible: MRC program reporting.
  - q3 self-heal: none possible. A person decides the split.
  - q4 dedup: one open exception per site+pool.
  - q5 tier-1 URL: yes.
- The existing `INV-POOL-NON-NEGATIVE` daily page is folded into this. While an exception is open it becomes a
  digest line, so the same condition never pages twice a day.
- No staff push. Managers see it in-app, born pilot.

## 8. Build status (2026-10-29, Mercer)

Branch `fix/adr0143-negative-inventory` from `origin/main` `3573f74`. Nothing pushed, merged or deployed.

| #   | Item                                | Status                  | Evidence                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Presenter, two raw pages, COR pools | BUILT                   | `presentOnHand()`; loads-inventory, iPad Today, count, yard through it; `assertCorPoolsNotNegative` in prefill + finalize. T1 `onhand-presenter.guard.test.ts` (red on the old page), T2 `today/page.onhand.test.tsx` (red on both old pages), T3 `inbound-gate.test.ts`. |
| 2   | One remedy                          | BUILT                   | `negativeFloorCopy().remedy` read by tile, daily report, iPad, `INV-POOL-NON-NEGATIVE`. T4 in `negative-floor.test.ts` + `invariants.test.ts`.                                                                                                                            |
| 3   | Migration + trigger                 | BUILT                   | `20260870_adr0143_inventory_exceptions` (clean replay + re-run no-op). T5/T6 `pool-guard.db.test.ts`.                                                                                                                                                                     |
| 4   | Sixth leg                           | BUILT                   | `computeRunningBalance.adjustments`, `computePoolBalance` reads approved rows. T6/T7 (`running-balance.test.ts`, `pool-guard.db.test.ts`).                                                                                                                                |
| 5   | Post-write check on every writer    | BUILT                   | `guardPoolsInTx` in 14 writers; MyMRC bridges via the 10-min `/api/internal/inventory/pool-check` sweep. T8–T11 `pool-guard.db.test.ts`; writer scan `pool-guard-writers.guard.test.ts` (red when a guard is removed).                                                    |
| 6   | Alerting + in-app page              | BUILT, born pilot       | `exception-alerts.ts` (onset/7-day `high`, daily digest), `/dashboard/[site]/inventory-exceptions[/id]`, four-eyes API. T12 + flow tests `exception-flow.db.test.ts`. Live read-back of a page: NOT done (needs the deploy).                                              |
| 7   | Split convention                    | PARTIAL                 | Close page shows program available (`split-rule.ts`). The written rule for the workbook / MyMRC entry needs Bill (OPEN-ITEMS CH-7).                                                                                                                                       |
| 8   | Repair −247                         | SCRIPT + TESTS, NOT RUN | `scripts/propose-woodland-pool-repair.mjs` (proposal only). `woodland-repair.test.ts`, `woodland-repair.db.test.ts` (test site: −247/644/397 → 0/397/397 after a second identity approves).                                                                               |
| 9   | Verify live                         | NOT STARTED             | Needs the deploy (Ryan).                                                                                                                                                                                                                                                  |
| 10  | Visibility                          | NOT STARTED             | Jesse, after deploy.                                                                                                                                                                                                                                                      |
| 11  | 30-day hold                         | NOT STARTED             | Starts when 7 and 8 are in force.                                                                                                                                                                                                                                         |

§5 R-A (a count with a measured split) is withdrawn: Bill B3, the floor is mixed.
