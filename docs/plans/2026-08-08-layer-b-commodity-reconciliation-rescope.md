# Layer-B commodity reconciliation — re-scope after the Kelsey option closed

**Date:** 2026-08-08
**Status:** Plan / research memo. No code, no decision taken.
**Item:** `docs/OPEN-ITEMS.md` §0.AK **AK-4**, plus a decision deadline added to **AK-5 (C-43)** in §6.
**Context:** Kelsey Ruhland's availability ended **2026-08-08**. AK-4 was blocked on an audit-method capture from her that never happened. This memo establishes what can and cannot be specified without her, using figures measured against the production database on 2026-08-08 rather than carried forward from the register.

---

## 1. What died with the Kelsey option — stated honestly

AK-4 asked for "the audit-method capture from Kelsey … as [the rules'] requirements document". That capture did not happen and now cannot. What is genuinely, permanently lost:

- **The thresholds.** Which variance between a vendor invoice and our own figure is noise and which is a dispute. Nobody else has stated a number, and the tracker records none.
- **The per-field authority ranking.** When the invoice weight and our weight disagree, which one is believed, and on what basis. This is a judgement she exercised monthly for two years and it is written down nowhere.
- **The dollar-impact ordering.** AK-4's phrasing — "ranked by dollar impact" — presumes a sense of which streams carry the money. That ranking was hers.
- **The exception vocabulary.** What she did when an invoice arrived late, was re-issued, or covered a partial month. This is normally where the real rules live.

**These are not recoverable by reading documents.** Any attempt to reconstruct them from the artifacts below would be inventing thresholds, which AK-4 explicitly forbids ("Do not invent thresholds in the meantime"). That instruction stands and this memo does not soften it.

What is **not** lost is the *shape* of the method — its unit, its cadence, its participants and its coverage — because the tracker records all four as data. That is the recoverable part, and §3 is what it actually says.

---

## 2. Premises corrected on checking

Four premises this re-scope was commissioned on did not survive contact with production. They are corrected here first, because two of them change what the work is.

### 2.1 "The tracker's formulas/columns encode her method" — **partly false**

The absorbed tracker (`doc_commodity_audit_rows`, model in `prisma/schema.prisma:5887`) carries: `stream_group`, `stream_label`, `month_label`/`month_number`, `audited`, `initials`, `audit_date`, and a second-audit trio. **There are no formulas.** ADR-0080 D7 already established the document carries no tonnage and no money; the columns confirm it carries no thresholds, no tolerances, no authority ranking and no variance either.

The tracker encodes **that an audit happened, on what, by whom, when** — a coverage matrix. It does not encode **how** the audit was performed. The distinction is the whole re-scope: it can tell us the reconciliation's *unit of work* and *governance*, and it cannot tell us its *rules*.

### 2.2 "Rick/Shannon as interview subjects" — **half false, and the other half is Janette**

The tracker names its auditors, and the distribution is measurable:

| Initials | Person | Rows initialled | Status |
| --- | --- | --- | --- |
| `KR` | **Kelsey Ruhland** | **82** | Availability ended 2026-08-08 |
| `RA` | **Rick Albritton** | **17** | Active manager |
| `JT` | **Janette Tomas** | **15** | Active manager |
| `NONE` | literal "NONE" in cell | 5 | — |
| `Ra` | Rick, case variant | 1 | — |

**Shannon Rockwell has never initialled a commodity audit — zero rows, either year.** Interviewing her about the audit method would produce an account of a process she has not performed. She is the right person for Eugene's ops-signer duty (§0.AN) and the wrong person for this.

**Janette Tomas was not on the proposed interview list and should be.** She has 15 months of direct evidence — nearly Rick's 17 — and she is already the floor-side stakeholder for the #205 campaign.

**Corrected interview list, in priority order: Rick Albritton (18 rows incl. the case variant), then Janette Tomas (15).** Between them they hold 33 of the 120 initialled months, and critically they hold **all** of the surviving first-hand experience.

### 2.3 "Vendor invoice structure" is available as a specification input — **not in Vision it isn't**

Measured in production, 2026-08-08:

| Table | Rows |
| --- | --- |
| `outbound_materials` | **0** |
| `outbound_material_payments` | **0** |
| `outbound_vendors` | **0** |
| `recycling_rates` | **0** |
| `landfilled_units` | **0** |
| `invoices` | **0** |
| `processed_units_daily` | 990 |
| `mymrc_outbound_mirror` | 4,635 |

**The entire ADR-0037 / ADR-0052 / ADR-0055 outbound-commodity capture layer is empty.** This is the largest single finding in this memo and it was not in the register.

The consequence for AK-4 is structural, not incidental. A reconciliation rule needs two sides. Even with a perfect method capture from Kelsey, **there is nothing on the Vision side of the comparison to apply it to.** AK-4 was recorded as blocked on a stakeholder; it is *also* blocked on a data leg that does not exist. Unblocking the first would not have unblocked the work.

Note this also means the `Xtraction × metal = 0.8100` recycling-rate seed discussed at S-7/S-8 is **not present in production** — `recycling_rates` is empty. Whatever pinned that value pinned it in a test guard, not in prod data. Worth a separate confirmation; it is out of this memo's scope but should not be assumed live.

### 2.4 "The tracker was just classified" — **true, and it makes an OPEN-ITEMS line stale**

`doc_sources` in production, 2026-08-08:

| id (8) | display_name | doc_class | doc_class_source | site |
| --- | --- | --- | --- | --- |
| `8a0246e7` | `TEREX.xlsx` | `terex_maintenance_log` | `operator` | Woodland |
| `9f71ccb3` | `Woodland Data Auditing Tracker (1).xlsx` | **`commodity_audit_tracker`** | **`operator`** | Woodland |
| `82e6d34b` | `Woodland Trailer list.xlsx` | **`equipment_inventory`** | **`operator`** | Woodland |

The source id in the brief is confirmed. But **both AK-1 and AK-2 are now classified with `doc_class_source = 'operator'`**, while the §0.AM index table still reads _"AK-1 / AK-2 — Both still unconfirmed in prod (`doc_class IS NULL` on each)"_. That line was true when written and is stale now. §5 carries the correction.

The absorbed rows are **252, all `status = 'staged'`** — 144 (2026) + 108 (2025), 12 distinct streams across 2 sheets, matching ADR-0080's stated totals exactly. The absorption CONFIRM (preview → accept) remains outstanding and remains a human gate.

---

## 3. What the tracker CAN specify — measured, not inferred

Four things, all derived from the 252 absorbed rows.

### 3.1 The unit of reconciliation is (commodity stream × calendar month)

Not per load, not per day, not per invoice. Every one of the 252 rows is one stream-month. Any rules layer that reconciles at load granularity would be building something the business has never done.

### 3.2 The reference side is the vendor invoice, and the taxonomy is the stream list

The sheet banner is _"Commodity Audit (against Vendor Invoices)"_. The 12 streams are the taxonomy the business actually reconciles on, and it is **not** the same as `OutboundCommodity`:

`FOAM - All Vendors`, `METAL - GreenZone`, `METAL - SA`, `TOPPERS - All Vendors`, `TRASH - Yolo (Including wood waste)`, `WOOD- Biomass`, `WOOD- Renovation`, `WOOD- Sierra`, `WOOD- Yolo`, `XTRACTION`, `PLASTIC, CARDBOARD, SHODDY, COTTON, FIBER, OTHER`, `DAILY LOG/MYMRC/SPREADSHEETS`.

Two observations that matter:

- The taxonomy is **stream = commodity × vendor**, not commodity alone (`METAL` splits by GreenZone/SA; `WOOD` splits four ways). Any rules layer keyed on `OutboundCommodity` alone cannot express this, and `outbound_vendors` — the table that would carry the other half — is empty.
- **`DAILY LOG/MYMRC/SPREADSHEETS` is a stream.** The business treats "audit Vision's own numbers" as one more row in the same matrix, at the same monthly cadence. That is a design instruction about where this rules layer belongs, and it came from the document rather than from us.

### 3.3 There is a two-pass (four-eyes) discipline, and it has collapsed

`second_audit` / `second_initials` / `second_audit_date` are real columns with real data — and the trend is stark:

| Year | Stream-months | `audited` true | Coverage | `second_audit` true |
| --- | --- | --- | --- | --- |
| **2025** | 108 | 82 | **76%** | **27** |
| **2026** | 144 | 36 | **25%** | **0** |

2026 has **no second audit on any stream, in any month.** And `DAILY LOG/MYMRC/SPREADSHEETS` — the audit of Vision's own figures — sits at 5 of 12 months for 2026.

This is an operational finding that stands on its own regardless of what happens to AK-4, and it is the kind of thing the register exists to surface. It should be shown to Rick.

### 3.4 The cadence is monthly and the calendar is fixed

Twelve months per stream per year, in every one of the 21 stream-years. No partial periods, no rolling windows.

---

## 4. What could specify the rules now — ranked

| # | Source | What it can settle | What it cannot | Confidence |
| --- | --- | --- | --- | --- |
| 1 | **Rick Albritton (interview)** | Thresholds, per-field authority, exception handling, dollar-impact ranking. The only path to the genuinely lost content in §1. | Nothing, if his practice diverged from Kelsey's — ask explicitly rather than assuming one method. | **Highest.** 17 initialled months; the sole surviving deep source. |
| 2 | **Janette Tomas (interview)** | Corroboration, and the floor-side view of which discrepancies actually recur. | Same caveat. | **High.** 15 months, and already engaged on #205. |
| 3 | **The tracker itself** (`9f71ccb3`) | Unit, cadence, taxonomy, governance, coverage — §3. Already absorbed and queryable. | Thresholds, authority, variance. It holds no figures at all (ADR-0080 D7). | **Certain** — it is measured data. Bounded. |
| 4 | **Actual vendor invoices** | The real reference-side schema: what a GreenZone or Sierra invoice states, at what granularity. | Nothing about our tolerance for disagreeing with it. | **Unknown.** Not in Vision (`invoices` = 0). Needs Bill or Rick to supply real PDFs before it can be assessed. |
| 5 | **`mymrc_outbound_mirror`** | The only commodity figures Vision holds today — 4,635 records carrying `Outbound_Vendor_Name__c`, `Number_of_Program_Units__c`, `Entry_Date__c`. | Per-commodity weights: `Foam__c`, `Cotton__c`, `Cardboard__c`, `Plastics__c`, `Natural_Fiber__c`, `Quilt_and_Toppers__c`, `Other__c` appear on only **39 of 4,632** records — the detail pass has covered under 1%. | **Low as a reconciliation leg today.** Real, but not yet populated enough to compare anything. |
| 6 | ~~Shannon Rockwell~~ | — | — | **Excluded** — zero audit history (§2.2). |

---

## 5. Re-scoped plan

The honest re-scope is that **AK-4 as written cannot proceed, and should be split into three items that can.**

### AK-4a — Capture the method from Rick, then Janette *(unblocks the rest; do first)*

A structured interview, not an open-ended one. Bring the §3 findings as the starting artifact so the conversation begins from measured facts rather than recall. The five questions, in order:

1. When the vendor invoice and our figure disagree, **how big does the gap have to be** before you do something? A number, per stream if it differs.
2. **Which side wins** when they disagree — and does that differ by stream or by vendor?
3. What do you do about a **late, re-issued, or partial-month** invoice?
4. Which streams **actually carry the money** — i.e. where is a 5% error expensive?
5. **Second audit: what was it for, and why did it stop in 2026?** (Show the §3.3 table.)

Ask Rick and Janette **separately**, and record where they diverge rather than reconciling their answers into one narrative. Divergence is itself a finding.

**Deadline: propose 2026-08-22.** Rick and Janette are permanent staff, so this is not a hard external deadline — but AK-4 has now lost one stakeholder to an unbounded schedule, and an item with no date is how that happened.

### AK-4b — Establish the Vision-side data leg *(the blocker nobody had recorded)*

Per §2.3, `outbound_materials` and its whole family are empty. Before any rule can run there must be something to run it against. This is a prerequisite, and it is a product decision — is outbound commodity capture in scope at all, and if so, does it come from operator entry (ADR-0037), from the MyMRC detail pass (§4 row 5), or from the invoices themselves?

**No rules work should start before this is answered.** Building a rules layer over four empty tables is the most expensive way to discover the question.

### AK-4c — Then, and only then, specify the rules

With a method (4a) and a data leg (4b), the rules layer is a normal piece of work: unit and cadence come from §3, taxonomy from §3.2, thresholds from 4a. Until both land, this stays unstarted, and **`docs/OPEN-ITEMS.md`'s "do not invent thresholds" instruction remains in force.**

### Housekeeping surfaced by this memo

- **Correct the §0.AM index line for AK-1/AK-2** — both are now `doc_class_source = 'operator'` (§2.4). The register currently says the opposite.
- **The 252 absorbed rows are `staged`, not confirmed.** The absorption CONFIRM is still outstanding and is still Bill's click.
- **`recycling_rates` is empty in production** (§2.3) — confirm whether the S-7 `0.81` seed was ever expected to be live.
- **Kelsey Ruhland's user row is still `is_active = true`** as of 2026-08-08, the day her availability ended. §0.AN correctly moved her signer duties to Shannon and confirmed she held no approver roles, so nothing is misrouted — but an active account for a departed person is an access-review item, not a data item. Flagging it here because this memo is where it was noticed, not because it belongs to AK-4.

---

## 6. AK-5 (C-43) — decision deadline

**Verified in code, 2026-08-08:** `SHARED_WITH_ME_SUNSET = '2026-11-01'` and `SHARED_WITH_ME_SUNSET_IS_INFERRED = true` in `src/lib/doc-ingest/pipeline-config.ts:171,178`, consumed by `src/lib/doc-ingest/health.ts` (which renders both the date and the fact that it is inferred). The register's §0.AK entry is accurate and the mitigations it describes are real.

What the register lacks is a **date by which the decision must be made**, as distinct from the date the API stops working. Those are not the same, and the gap between them is the entire build window.

**Proposed decision deadline: 2026-10-01.**

Rationale, stated so it can be argued with:

- The sunset is `2026-11-01`, and that date is **itself an inference** — Microsoft published a month, not a day. The real cutoff could be anywhere in November, or earlier in practice as the "degraded state" degrades further.
- `sharedWithMe` is **already** under-returning in production (C-49: 1 item against ≥2 genuinely shared). The degradation is not a future event.
- Every candidate successor is either ruled out or unbuilt: `/me/insights/shared` is deprecated **on the same date**; `SharedWithUsersOWSUser` was tested against this tenant and returned 0; `POST /search/query` is deliberately a reachability probe only, because adopting it as the enumeration would widen intake to case-management and HR material (a security delta, per ADR-0080 and C-47).
- The remaining serious option — **move primary discovery to a SharePoint library**, where `delta` is the only enumeration Microsoft guarantees complete (ADR-0067 Am.6 §E, C-48, C-49) — is not a code change. It requires owners to move or re-share documents, which is people-and-process work with a tail measured in weeks.

**One month between decision and sunset is the minimum that leaves room to build, verify against the live tenant, and migrate the document owners.** A decision taken in late October would be a decision to run past the sunset.

Recommend recording `2026-10-01` against AK-5 in `docs/OPEN-ITEMS.md` as a **decision-by** date, distinct from the `2026-11-01` sunset already rendered on `/admin/doc-ingest/health`, and — if there is an appetite for it — surfacing the decision deadline on that health page too, since a countdown to an event nobody has scheduled a decision for is a countdown to being surprised.

---

## 7. What this memo does not do

- It does not specify any reconciliation rule, threshold or tolerance. §1 and AK-4c explain why that would be invention.
- It does not decide C-43. It puts a date on deciding it.
- It does not touch code, migrations or production data. Every figure in it came from a read-only query run on 2026-08-08.
