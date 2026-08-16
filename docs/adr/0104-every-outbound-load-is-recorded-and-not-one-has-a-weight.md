# ADR-0104 — Every outbound load is recorded, and not one of them has a weight

**Date:** 2026-08-15 (Pacific)
**Status:** Accepted. Design only — no absorber is implemented by this ADR.
**Ordered by:** Bill, 2026-08-15 evening PT: _"build whatever is needed to make that happen and get this working full in its entirety."_
**Implements:** the disposition of all 11 watched `doc_sources` after ADR-0100's reachability work closed the discovery gap (`reachabilityGap` 0).
**Builds on:** ADR-0069 (absorption bridge, §D1 one-writer rule), ADR-0069 Am.1/Am.2 (trailer, TEREX), ADR-0077 (the triple-count and the version pin), ADR-0080 (§D8 version-scoped from the first row, §D7 the tracker is not what it was believed to be), ADR-0067 §3.2 (classify once, confirm once).
**Related:** ADR-0037/ADR-0055 (`outbound_materials`, the stewardship split), ADR-0041 (`invoices` lifecycle), ADR-0049 (workbook-sync is the sole writer of `processed_units_daily`), ADR-0062 (equipment master), ADR-0087 (VLM equipment identity — Proposed, unbuilt), ADR-0079 (Terex throughput is captured, not derived).
**Deliberately does NOT do:** write any operational table; specify any variance threshold, tolerance or mismatch alert (that is `docs/plans/2026-08-08-layer-b-commodity-reconciliation-rescope.md` **AK-4c**, Bill's call with Rick and Janette); implement a single extractor. §D3, §D10, and "What this does not fix".

---

## Context

ADR-0100 and ADR-0102 closed the discovery and transport gaps. As of this session every reachable document is watched, `reachabilityGap` is 0, and sweep run 22082086 created and applied versions for the six newly-registered sources with 0 anomalies.

Watching is not ingesting. Measured live against prod, 2026-08-15 PT:

|                                               | Count |
| --------------------------------------------- | ----- |
| Watched `doc_sources` (`state='active'`)      | 11    |
| With a confirmed `doc_class`                  | 3     |
| Actually absorbing rows                       | 3     |
| Sitting on an unconfirmed classifier proposal | 8     |

Three documents absorb (`doc_trailer_rows` 96, `doc_terex_maintenance_rows` 400, `doc_commodity_audit_rows` 252). Eight do not, and two of those eight hold the figures the operation is missing.

### The measurement that decides this ADR

`mymrc_outbound_mirror` — the authoritative MyMRC-derived record of outbound shipments — holds **4,673 loads spanning 2023-01-02 to 2026-08-14**, every one of them carrying an `external_materials_id`, a `bol_id`, a `shipment_date`, an account and a status. Every one of them has a site; none has disappeared.

```
 total | weight_set | prog_nonzero | nonprog_nonzero
-------+------------+--------------+-----------------
  4673 |          0 |          135 |              92
```

**`weight_lbs` is NULL on 4,673 of 4,673 rows.** Not sparse. Not stale. Zero. Only 39 rows (0.8%) carry any commodity payload fields at all, and those are mostly disposition strings. The system knows that every load left, when, on what BOL, to whose account — and does not know what any of them weighed.

"Woodland Outbound Auditing 2026.xlsx" is a MyMRC report-export that carries exactly that missing figure, per commodity, per load:

| Month   | Mirror loads | Workbook loads |
| ------- | ------------ | -------------- |
| 2026-01 | 131          | 131            |
| 2026-02 | 113          | 113            |
| 2026-03 | 135          | 135            |
| 2026-04 | 159          | 158            |
| 2026-05 | 140          | 139            |
| 2026-06 | 156          | 155            |
| 2026-07 | 176          | —              |
| 2026-08 | 81           | —              |

Spot-checked seven Materials IDs drawn from seven different workbook sheets (`M-156388`, `M-158258`, `M-160053`, `M-163215`, `M-167035`, `M-171559`, `M-175497`): **all seven resolve in the mirror**, with matching BOL and shipment date. `mymrc_outbound_mirror_external_materials_id_key` is a UNIQUE index. The join is exact and free.

This is not a new outbound data source. It is the weight column of a table the system already owns.

### The three double-count traps, all of the ADR-0077 family

ADR-0077 cost the system a management total of $231,203.82 for a $77,067.94 document. Absorbing these files naively reproduces that class three separate ways, and all three were found by measurement, not by inspection.

**(a) The workbook double-counts itself.** 16 sheets, 11 of which carry a `Shipment Date` header. Four of those eleven are exact duplicates of another:

```
"Outbound Feb 2026"    ∩ "Feb2026 outbounds"        = 113 (a=113 b=113) IDENTICAL SET
"Outbound Mar 2026"    ∩ "Mar2026 Outbound"         = 135 (a=135 b=135) IDENTICAL SET
"May2026 Outbounds"    ∩ "May2026_Outbounds"        = 139 (a=139 b=139) IDENTICAL SET
"April2026 Outbounds"  ∩ "April2026 Outbounds (2)"  = 158 (a=158 b=158) IDENTICAL SET
"Outbound Jan 2026"    ∩ "xtraction (2)"            =  11 (a=131 b= 11)
```

545 of ~1,085 loads appear twice, and 11 more appear in a filtered subset sheet. A per-sheet absorber that trusts sheet names would report roughly 1.5× the real outbound tonnage. The duplicates are not sloppy re-keying — they are the same rows pasted with different formatting, which is why `Outbound Feb 2026` stores `Shipment Date` as real Excel `Date` objects and `Feb2026 outbounds` stores the serial `46055` for the same shipment.

**(b) The most authoritative-sounding column is sign-flipped.** The last column of every monthly sheet is `Total Outbound Materials Weight`. Measured across `Outbound Feb 2026`:

```
sum(Total Outbound Weight)           =  763813
sum(Total Outbound Materials Weight) = -763813
sum(commodity parts)                 =  763813
rows where parts != TotalMaterialsWeight (>1 lb): 113 of 113
commodity cells negative=0 positive=120
```

`Total Outbound Weight` is the real per-load figure and it reconciles to the sum of the 13 commodity columns exactly. `Total Outbound Materials Weight` is a check column holding its negation. An extractor that picks the right-most, most official-sounding column ingests every weight in the operation with the wrong sign — and because it is internally consistent, nothing downstream would look wrong until a total was compared against reality.

**(c) There are two TEREX.xlsx files.** `doc_source` `8a0246e7` is Janette's live document (last modified 2026-08-15 00:43). `doc_source` `5b298aeb` is a frozen copy on Kelsey Ruhland's departed-account OneDrive (last modified 2026-07-29). They are not byte-identical — 491,676 vs 492,470 bytes, different SHA-256 — but structurally they are the same document: 40 sheets each, identical sheet names, no sheet present in one and absent from the other, and **`Maintenance Log 2025` holds 173 rows in both**. The classifier proposes `terex_maintenance_log` at 0.81 for the copy, correctly. Confirming that proposal is all it would take to absorb every maintenance event a second time.

### What the other six documents actually are

The handoff listed four as "contents UNKNOWN". They were read.

- **DR3 Data Tracking.xlsx** (12 sheets, 338 KB) is an analyst's derived workbook: 12–38% of populated cells are formulas, sheets are cross-tabs with several independent tables laid side by side, and the content is forecasts (75/90/95/99% confidence bands), recycling and recovery percentages, mass balance, and commodity pivots. Its `Mass balance` sheet is titled, verbatim, **"Woodland Mass Balance - WORKING, NOT OFFICIAL"**. It also covers Stockton, which is not a registered site.
- **JOURNAL Woodland Facility.xlsx** is an operations journal, `Date | Name | Notes`, and the C-47 sensitivity concern **does not trigger**: the content is equipment uptime ("Terex was down shafter,", "Terex is up and running", "Terex operational again"), vendor approvals ("Worm Farm is approved as a vendor by Christine Messer for Natural Fiber"), an MRC visit, and a failed fire inspection ("too much inventory and the map was not follow"). Two entries mention hiring in aggregate ("Interviewed 15 candidates today for Processor position") with no candidate named. There is no case-management, client or PII content. It carries ~30 real entries from January to April 2026 and then empty month scaffolding through December — it went stale in April.
- **DR3 Task Lists for 2025.xlsx** is a project tracker (`PROJECT TITLE: | PRIORITY: | DUE DATE: | % COMPLETE: | DONE: | NOTES:`) plus one genuinely operational sheet, `Licenses, Registrations, etc` (41 rows: `WOODLAND | Filed Through | Expires | Last filed | Tasked to | Cost | Link | Notes`). It is a 2025 file.
- **DR3 Meeting Notes Log 2026.xlsx** is 452 rows of free text under `Meeting Date | Attendees | oregon | working toward assessment`.
- **DR3 Machine List (2).xlsx** is **not a DR3 equipment roster**. 554 data rows, 440 VIN/serials, and 34 distinct `Location/Department` values spanning the whole St. Vincent de Paul estate — Egan, General Stores, Lindholm Center, the retail stores (Albany, Florence, Salem, Junction City, Thurston), Housing Services, Supportive Services for Veterans Families, the LIFT Program, the car lot — of which exactly two are DR3 facilities (`1233 Commerce Ave - DR3 Woodland` and `4447 S Airport Way - DR3 Stockton`). The `equipment` table already holds 568 rows.
- **Woodland Invoices tracking.xlsx** is a hand-kept desk log, 369 data rows totalling ~$996,789 across `WOODLAND 2025/2026` and `STOCKTON 2025/2026`.

### Two premises from handoff #259, falsified on checking

The brief that commissioned this work carried two claims about the Invoices file. Both were re-measured against the live bytes and both are wrong at scale:

- _"Notes carry hand-recorded linkage: ticket numbers that ARE BOL IDs, M-id lists…"_ — **1 row of 369** carries any `M-######` id (that one row names three). Eleven rows say "MyMRC" in prose. The linkage exists as an anecdote, not as a column.
- _"29 rows carry H-haul numbers in `commodity`"_ — measured **6**, all in `WOODLAND 2026`, none in `WOODLAND 2025` or either Stockton sheet.

No join keyed on free-text notes is designed here. A join built on 1 row in 369 is not a join.

---

## Decision

### D1 — Two new absorbable classes, and they land in reference tables, not operational ones

`outbound_weight_audit` and `facility_expense_log` are added to `DOC_KINDS` and to `ABSORBABLE_KINDS`, each with its own extractor, its own typed table, and its own migration.

They do **not** write `outbound_materials`, `outbound_material_payments`, `outbound_vendors`, `recycling_rates`, `landfilled_units`, or `invoices`. That was a live question and it is answered against measurement, not against the pattern:

- All six operational tables hold **0 rows** in prod. Writing `outbound_materials` requires `vendor_id → outbound_vendors` and a `recycling_rate_id → recycling_rates` keyed `(vendor_id, commodity, ship_date)` to satisfy ADR-0055's invariant `recycled_lbs + landfilled_lbs == weight_lbs`. The workbook contains neither a vendor master nor a rate master. Standing them up from a spreadsheet's `Disposition` strings would be fabrication, and ADR-0080's rule is that fabricating a record is worse than an empty one.
- `invoices` (ADR-0041) carries an immutable-version discipline, a lifecycle state machine and delivery planning. The Invoices tracking file is a desk log of things already paid — it has no invoice lifecycle, and writing it there would manufacture payable-looking records that were never payables.
- ADR-0069 §D1 rejected the alternative by name: _"A `source` discriminator so both may write. This makes the collision representable rather than impossible, and the collision would be discovered in payroll."_
- The reference landing is **strictly more useful here anyway**, because the join target already exists and is empty in exactly the right place. `doc_outbound_load_rows.external_materials_id → mymrc_outbound_mirror.external_materials_id` closes a 4,673-row gap with both sides' provenance intact.

Standing up the operational leg is **AK-4b**. Specifying what a disagreement between the two sides _means_ is **AK-4c**. Neither is in scope.

### D2 — `outbound_weight_audit`: the unit is the load, and the load's identity is `Materials: Materials ID`

Two tables, both version-scoped per ADR-0080 §D8:

- `doc_outbound_load_rows` — one row per (version × `external_materials_id`). Identity, `bol_id`, `shipment_date`, `total_weight_lbs`, program/non-program unit counts, the originating `sheet_name` and `row_index`, and `status`.
- `doc_outbound_commodity_rows` — one row per (version × `external_materials_id` × commodity), written only where the commodity's `(lbs)` cell is non-null. Feb 2026 has 120 populated commodity cells across 113 loads, so the grain is sparse and a child table is correct. A 26-column-wide parent would encode the commodity vocabulary in the schema, where adding a commodity becomes a migration.

`total_weight_lbs` is taken from **`Total Outbound Weight`**, never from `Total Outbound Materials Weight`. The latter is stored as `total_weight_check_lbs` precisely so the guardrail can assert the negation and fail loudly if the workbook's convention ever changes.

`Disposition` has a closed four-value vocabulary in the live file — `Recycling`, `Landfill`, `Biomass`, `Renovation` — and is stored **verbatim**, not mapped. Mapping `Landfill` onto `landfilled_units` semantics is exactly the operational-write D1 forbids.

### D3 — De-duplication is within-version, cross-sheet, on `external_materials_id`, and it is reported

`extractOutboundFromWorkbook` receives every sheet at once and returns one workbook-level result — the `terex-extract.ts` shape, not the per-sheet `commodity-extract.ts` shape. That choice is forced by the data: the duplicates are cross-sheet, so a per-sheet extractor structurally cannot see them.

The rule is deterministic and stated: **first sheet in workbook order that yields a given `external_materials_id` wins**; every later occurrence is dropped, counted into `duplicatesRemoved`, and its sheet named in `duplicateSources`. Because the four duplicate pairs are byte-equal in content, which one wins does not change a figure — but a rule that depends on which one wins is a rule that will change a figure later.

This also disposes of `xtraction (2)` (11 IDs, all present in `Outbound Jan 2026`) with no special case.

A sheet is a **candidate** only if it has both a `Shipment Date` and a `Materials: Materials ID` header. The five pivot sheets (`Foam_Topper`, `Wood`, `steel`, `trash`, `other`) are refused by that test, and refused deliberately: they carry `$/ton`, `total cost`, `gross profit` and `net profit`, they are recomputable from the load rows, and importing a derived margin as a fact is how a spreadsheet's arithmetic becomes the system's opinion.

### D4 — `facility_expense_log`: absorb the Woodland sheets, refuse the Stockton sheets by name

`doc_facility_expense_rows`, grain (version × sheet × `row_index`), staged.

`WOODLAND 2025` and `WOODLAND 2026` absorb. `STOCKTON 2025` and `STOCKTON 2026` are **refused per sheet** with the named reason `site_not_registered`, because Stockton is not a row in `sites` and hard rule #2 says a NULL site never reaches a site-scoped surface. Refusing two sheets does not sink the document — that per-sheet refusal discipline is `commodity-extract.ts`'s and it is reused here.

Values are stored as the sheet wrote them, following `doc_trailer_rows.material_raw`:

- `category_raw` verbatim. The live sheets hold 16 and 18 distinct values including case variants of the same category (`Transportation`/`transportation`, `Diesel`/`diesel`, `Supplies`/`supplies`) and the literal string `category` where a header row repeats mid-sheet. A `category_norm` column (trimmed, lower-cased) is written alongside for grouping. It is a convenience, not a taxonomy — nobody has agreed a taxonomy.
- Rows whose `category_raw` is literally `category` are a repeated header and are skipped.
- `commodity_raw` verbatim. The column is overloaded: real commodities (`wood`, `trash`, `pocket coils`, `mattresses`, `inbound units`) and 6 H-haul references. `haul_ref` is set only when the cell matches `^H-?\d+`, and null otherwise.
- `notes` verbatim, unparsed. See the falsified premise above.
- `amount` and `credit_amount` are `Decimal(12,2)` and **NULL when the cell was blank**, never 0. An expense with no recorded amount is not a free expense — the same rule ADR-0069 Am.2 wrote for `actual_repair_cost`.

### D5 — Both new classes stage; weights are not exempt from review because they are not dollars

`doc_trailer_rows` writes directly because it carries weights. These stage anyway, and the reason is specific rather than precautionary: the outbound weights are the input to CalRecycle stewardship percentages and to MRC reporting, this is the largest single injection of figures the system has taken (~1,085 loads), and the de-duplication in §D3 is a judgement that a human should ratify once. `facility_expense_log` carries dollars and stages for the ordinary ADR-0069 Am.2 reason.

Staging is a promise the repo has not kept once already: `doc_commodity_audit_rows` stages 252 rows and **there is no confirm control anywhere in the product** — `/admin/doc-ingest/commodity` is read-only and there is no `commodity-decide.ts`. Those 252 rows can never leave `staged`. This ADR does not replicate that gap: each new staging class ships a `*-decide.ts` batch service on the `terex-decide.ts` contract (the batch is a **version**, not a row; totals are captured into the audit row as the evidence of what was on screen), a mutation route, and a review client. The commodity gap itself is registered as a promise, not fixed here.

### D6 — Any read that aggregates pins the winning revision first

Version-scoped uniqueness means N confirmed revisions coexist, each a complete copy. Every read module written for these classes resolves one `doc_source_version_id` and then aggregates only inside it, on the `terex-ledger.ts` / `commodity-ledger.ts` contract. Scope is `'confirmed' | 'staged'`, **never a union of the two**.

This is ADR-0077's whole lesson and it is not optional. It is restated here because the new outbound table is the first one whose figures will be summed against an external record, which is precisely the situation in which a plausible-looking wrong total survives review.

### D7 — Kelsey's TEREX copy is classified honestly and disabled

`doc_source` `5b298aeb` is confirmed as `terex_maintenance_log`, site DR3 Woodland — which is what it is — and then **`enabled` is set to `false`**.

The alternatives were both worse. Leaving it unconfirmed leaves a permanent unanswered question that ADR-0067's "classify once, confirm once" exists to eliminate, and leaves it one click from catastrophe. Inventing an `*_archive` class to hold it is a lie about what the document is, and a future confirm flow could re-register it. `runAbsorptionPass` selects on `enabled: true` AND `doc_class IN ABSORBABLE_KINDS`; `ABSORBABLE_KINDS` has no per-source exemption and should not grow one. `enabled=false` is the only state that is simultaneously honest about the document and structurally incapable of absorbing it.

Because the source is a frozen snapshot on a departed account it will never change again, so nothing is lost by no longer polling it.

A regression test asserts the general form of this: **at most one enabled `doc_source` per single-instance absorbable class per site**. That guard would have caught this before a human noticed, and it is the thing that survives after everyone has forgotten why `5b298aeb` is disabled.

### D8 — Four archive-only classes, registered so the classifier stops asking

`facility_journal`, `meeting_notes_log`, `admin_task_tracker`, `analysis_workbook` are added to `DOC_KINDS` and **not** to `ABSORBABLE_KINDS`. `DR3 Machine List (2).xlsx` takes the existing `equipment_inventory`, which is already in `DOC_KINDS` and correctly absent from `ABSORBABLE_KINDS`.

Registering a class for a document nobody will absorb is not bookkeeping. An unconfirmed source is re-proposed every sweep and shows up as an open question on the admin surface forever; a registered one is answered. Each refusal has a measured reason:

| Document                        | Class                 | Why not absorbed                                                                                                                                                                                                                                                                          |
| ------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR3 Data Tracking.xlsx          | `analysis_workbook`   | 12–38% formula cells; cross-tab layouts; forecasts and ratios. Its own `Mass balance` sheet says **"WORKING, NOT OFFICIAL"**. Its inbound-unit and recovery-rate figures are things Vision computes — absorbing them creates a second, disagreeing source of truth. Also covers Stockton. |
| JOURNAL Woodland Facility.xlsx  | `facility_journal`    | Free prose. Turning _"Terex was down shafter,"_ into a typed downtime interval requires inference, and ADR-0079 already decided Terex throughput is **captured, not derived**. Not withheld for sensitivity — see Context.                                                                |
| DR3 Meeting Notes Log 2026.xlsx | `meeting_notes_log`   | Free prose, same reason.                                                                                                                                                                                                                                                                  |
| DR3 Task Lists for 2025.xlsx    | `admin_task_tracker`  | A 2025 project tracker. Its one operational sheet (`Licenses, Registrations, etc` — expiry dates, 41 rows) is real value, but it is stale; see §D9 promise.                                                                                                                               |
| DR3 Machine List (2).xlsx       | `equipment_inventory` | 32 of its 34 locations are not DR3 facilities; site would be NULL for most rows and hard rule #2 refuses them anyway. `equipment` already holds 568 rows and has a sole writer. This is the parent charity's fleet register, not a DR3 roster.                                            |

### D9 — Two live defects found on the way, both fixed here because both would corrupt this work

**The classifier's prompt disagrees with its own enum.** `classifier.ts:320` tells the model `kind must be exactly one of: ${DOC_KINDS.join(', ')}` — all nine — and then hands it a bullet list describing only six. `trailer_list`, `terex_maintenance_log` and `commodity_audit_tracker` are named as legal and never explained. The Outbound file's stored `proposed_reasoning` shows the model reasoning its way through the contradiction in prod:

> _"`commodity_audit_tracker` is the closest listed kind, but since that kind is not in the allowed list, and none of the allowed kinds clearly match…"_

It read the bullet list as the allow-list, because a described vocabulary beats an undescribed one. Fix: a single `DOC_KIND_DESCRIPTIONS: Record<DocKind, string>` from which the prompt's bullet list is generated, so adding a kind without describing it fails the type-check.

**The confirm dropdown cannot select any absorbable class.** `SourcesClient.tsx:23` hardcodes:

```ts
const KIND_OPTIONS = [
  'daily_log_workbook',
  'ap_history_report',
  'equipment_inventory',
  'rate_table',
  'mrc_invoice',
] as const;
```

All three absorbable classes are missing, though the API route accepts them (its `CONFIRMABLE_KINDS` is correctly derived from `DOC_KINDS`). A second consequence at line 157: the form's draft pre-fill only accepts the classifier's proposal when `KIND_OPTIONS.includes(proposedClass)`, so a correct `commodity_audit_tracker` proposal is silently dropped from the form. Fix: derive `KIND_OPTIONS` from `DOC_KINDS` and make `KIND_LABEL` a `Record<DocKind, string>` so a new class fails to compile until it is labelled. Adding six more string literals to a list that is already three stale would be shipping the defect again.

### D10 — The reconciliation read surfaces the join. It does not grade it.

A read module and a read-only admin page join absorbed load rows to `mymrc_outbound_mirror` on `external_materials_id` and show, per month: loads in the mirror, loads with an absorbed weight, loads without one, and the summed weight — each figure labelled with the pinned `doc_source_version_id` it came from.

There is no threshold, no tolerance, no alert, and no `ok`/`mismatch` verdict anywhere in it. Whether a disagreement is a problem, and at what size, is **AK-4c**, and it belongs to Bill with Rick and Janette. Encoding a guess at that rule now would make the guess authoritative by being first, which is how the commodity tracker acquired a shape nobody had agreed to (ADR-0080 §D7).

---

## Consequences

- The system gains a weight for ~1,085 Woodland outbound loads that currently have none, and the shape of the remainder becomes visible: 4,673 mirror loads, of which the workbook can only ever cover Jan–Jun 2026 at one site. **The first honest readout will show that most loads still have no weight**, which is worse-looking than today's silence and is the point.
- Two new staged classes mean two new things Bill must confirm before they count. That is three confirm surfaces where there is currently one (TEREX).
- Confirmations are executed under Bill's user id per his instruction; the audited precedent is ADR-0077 D1, and the actor discipline is `{userId}` XOR `{label}` — a named non-human run writes `actor_label` with `actor_user_id` NULL and never borrows a `users.id`.
- Six new `DOC_KINDS` entries and one reused one take the unconfirmed count from 8 to 0. Every watched document has an answer.
- `5b298aeb` stops being polled. If a successor to Kelsey's snapshot ever appears it registers as a new `doc_source` and gets classified on its own merits — the disable is on the row, not on the filename.
- Both money files are frozen snapshots on a departed account. The design tolerates the source never updating again: absorption is version-scoped, so the last absorbed revision stays readable and correct indefinitely, and a successor file arriving later absorbs as its own source without touching the old rows.
- The `doc_commodity_audit_rows` staging gap is now written down. 252 rows have been unconfirmable since ADR-0080 shipped.
- Nothing in this ADR writes `processed_units_daily`, `outbound_materials`, `invoices`, `equipment`, or any other operational table. The one-writer rule is intact.

## Alternatives considered

- **Land outbound weights in `outbound_materials` and expenses in `invoices`.** Rejected on measurement: both tables' prerequisite masters (`outbound_vendors`, `recycling_rates`) are 0 rows and the workbooks contain neither, so ADR-0055's `recycled_lbs + landfilled_lbs == weight_lbs` invariant could only be satisfied by inventing rates. Also rejected on ADR-0069 §D1, which named the discriminator-column version of this idea and refused it.
- **Absorb `Total Outbound Materials Weight` as the load weight.** Rejected on measurement: it is the negation of the real figure on 113 of 113 sampled rows.
- **Absorb every sheet with a recognisable header.** Rejected on measurement: 545 of ~1,085 loads are duplicated across four identical sheet pairs, plus 11 in a subset sheet.
- **Per-sheet extractor (the `commodity-extract.ts` shape) for the outbound workbook.** Rejected structurally: the duplication is cross-sheet, so a per-sheet extractor cannot see it. The `terex-extract.ts` workbook-level shape is used instead.
- **Confirm Kelsey's TEREX copy as `terex_maintenance_log` and rely on care.** Rejected: `ABSORBABLE_KINDS` is a set of class names with no per-source exemption, so confirming it _is_ scheduling the double-absorb. `enabled=false` makes it impossible rather than unlikely.
- **Give the TEREX copy its own `terex_maintenance_log_archive` class.** Rejected: it misdescribes the document, and a distinct class name is a door a future confirm flow can walk through.
- **Delete the TEREX copy's `doc_source` row.** Rejected: it destroys the record that a duplicate existed, and the reachability scan would re-register it on the next sweep.
- **Absorb the JOURNAL as typed Terex downtime events.** Rejected: it is free prose, and ADR-0079 already decided Terex throughput is captured, not derived. Deriving downtime intervals from sentences would produce a confident number with no source.
- **Absorb DR3 Data Tracking's inbound and recovery figures.** Rejected: they are 12–38% formulas over data Vision computes itself, they cover an unregistered site, and the sheet with the headline figures is titled "WORKING, NOT OFFICIAL".
- **Absorb DR3 Machine List into `equipment`.** Rejected on measurement: 32 of 34 locations are outside DR3, `equipment` already has 568 rows and a sole writer, and hard rule #2 would refuse most rows for NULL site regardless.
- **Add six string literals to `KIND_OPTIONS` and move on.** Rejected: the list is already three classes stale and silently drops correct proposals. A hand-maintained mirror of an enum drifts; a derived one cannot.
- **Specify variance thresholds now, while the data is fresh in mind.** Rejected: AK-4c is Bill's decision with Rick and Janette, and a guess made first becomes the default by inertia.

## What this does not fix

- **It ingests nothing by itself.** This is a design record; the build is `docs/plans/2026-08-15-full-document-absorption-build.md` and the absorbers do not exist yet.
- **It does not give the other ~3,590 outbound loads a weight.** The workbook covers Woodland, January to June 2026. Loads before 2026, after June 2026, and every Eugene load remain weightless, and no document currently watched supplies them. The readout in §D10 will say so.
- **It does not reconcile anything.** It makes the two sides joinable and visible. What a disagreement means is AK-4c.
- **It does not stand up the operational outbound leg.** `outbound_materials` and friends remain 0 rows. That is AK-4b.
- **It does not close the `doc_commodity_audit_rows` staging gap.** 252 rows remain unconfirmable; that is registered as a promise, not repaired here.
- **It does not make the two money files durable.** They are frozen snapshots on a departed account, the retention risk is already on record, and this ADR only ensures the system stays correct when they stop existing.
- **It does not capture the licence and registration expiry dates**, which are real operational value sitting in a stale 2025 file. That needs a current document, not an extractor.
