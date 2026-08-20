# Full-repo research audit — DR3-Vision

**Date:** 2026-08-19 (Pacific, 20:05 PDT). **Author:** research lane (read-only).
**Repo state:** `main` @ `edb195f`. Branch `docs/h276-full-audit`, own worktree.
**Companion:** the engineering/repair lane ran in parallel; this document is the research half.
**Builds on:** `docs/2026-08-19-h276-phase0-woodland-workbook-parity-audit.md` (branch
`design/h276-parity-audit`). Its findings F-1..F-6 and gaps G-1..G-15 are the starting
inventory and are **not** re-derived here — except where this audit corrects them.

**Nothing was written to production.** Every DB statement was a `SELECT` (enforced by a
wrapper that refuses anything else). Every Microsoft Graph call was a GET. No workbook,
no OneDrive item, no R2 object was modified. PR #275 was not touched;
`design/h276-parity-audit` was not modified.

---

## PART 1 — THE INVOICE VERDICT

### The question

Phase 0 proved the Woodland daily-log workbook carries byte-identical duplicate row pairs
and that its `Transportation Total` sums both copies (July: 112,150 raw / 56,075 distinct).
It could not answer whether the **real invoice DR3 sent MRC** carried the doubled number.
That decides cosmetic-sheet-defect vs billing incident.

### Verdict

**It is a billing incident, not a cosmetic defect — with one honest caveat.**

What is **proven**:

1. **The invoice is a mechanical, cell-for-cell transcription of exactly the totals the
   duplication corrupts.** Demonstrated end-to-end on May 2026, to the cent (§1.2).
2. **July's workbook figure is doubled by exactly 2.000×**, and July's own
   `End Of Month Trans Invoice` cell reads **135,209.81**, which decomposes exactly as
   doubled-freight + rental + doubled-fuel + events (§1.3).
3. **The correct July figure is 74,254.90. Overstatement: $60,954.90** (§1.4).
4. **August is running at +$27,840.24 and is not yet invoiced** — it is still stoppable.
5. **The defect is dated: it begins in July 2026.** April, May and June are clean —
   raw == distinct on every table. This corrects Phase 0's "chronically" framing (§1.5).

What is **not proven**: I could not obtain the July invoice document itself. Only **May**
has a filed invoice in Kelsey's OneDrive; April, June, July and August `MRC Billing`
folders are **empty** (verified by direct Graph listing, §1.6). So the inference to July
rests on the May-proven mechanism plus the July sheet's own figures — not on a July PDF.
It remains formally possible that whoever prepared July's end-of-month billing workbook
noticed the duplicate pairs and removed them by hand.

**Two pieces of evidence make that unlikely.** First, the July daily log was last saved
**2026-08-04 15:56 PDT** — inside the end-of-month preparation window (May's was prepared
June 3–4) — and the duplicate pairs are still present in that saved file today. Second,
July's `Summary` tab is broken in a way that removes every cross-check: every processing-invoice
figure evaluates to `#VALUE!`, and **the only billing number that still computes is the
doubled transportation one** (§1.7).

**The one action that settles it:** pull the July transportation invoice (the May pair was
`IVC072595` processing / `IVC072596` transportation) from SVdP accounting and read its
freight line. **56,075 → sheet-only defect. ~112,150 → MRC was over-billed and a credit
memo is owed.**

---

### 1.1 How the invoice is actually built (the chain, proven on May)

May 2026 is the only fully-filed month. Its `MRC Billing` folder holds the daily log, the
end-of-month billing workbook, and the scanned invoice. That lets the whole chain be
verified rather than assumed.

| Stage | Artifact | Figure |
| --- | --- | --- |
| 1. Daily log | `MAY 2026 DAILY LOG WOODLAND(1).xlsm` → `May2026 inb trans charges`, 45 data rows, Total row | Freight `49,050` · Fuel `5,022.442076923076` |
| 2. EOM billing workbook | `MAY 2026 WOODLAND trans billing end of month.xlsx` → `May2026 inbound trans charges`, 45 data rows (r4–r48), Total row r49 | Freight `H49 = 51,350` · Fuel `L49 = 5,220.170230769229` |
| 3. Its `summary` tab | r5 Transportation `51,350` · r6 Container Rental `10,800` · r7 Event Freight `925` · r8 Fuel `5,302.570230769229` | r11 **May month Total `68,377.57023076923`** |
| 4. **The real invoice** | `5.31.26 MRC Trans IVC072596.pdf`, 5/31/2026, Bill To: Mattress Recycling Council, Attn: Ryan Trainer | `MRC Freight - rental Cal sites 5/31/26` = **$63,075.00** · `surcharge - May` = **$5,302.57** · **Total $68,377.57** |

The arithmetic closes exactly:

- `51,350 (freight) + 10,800 (rental) + 925 (event) = 63,075` → the invoice's freight line, **to the dollar**.
- `5,220.170230769229 (fuel column total) + 82.4 (Events tab fuel, P4) = 5,302.570230769229` → the invoice's fuel line, **to the cent**.
- `68,377.57023076923` → invoice total **$68,377.57**.

**There is no de-duplication step anywhere in this chain.** Stage 2 has the same row count
as stage 1 (45 → 45); only per-row rates were corrected during end-of-month review
(49,050 → 51,350). The invoice line is a plain `SUM` over whatever rows sit in the table.
**If the table holds each row twice, the invoice line is exactly twice as large.**

### 1.2 The invoice document itself

`5.31.26 MRC Trans IVC072596.pdf` is a scanned image (2 JPEG pages, `DCTDecode`, no text
layer), read visually. Header: ST. VINCENT de PAUL, DBA DR3 MATTRESS RECYCLING, P.O. Box
24608, Eugene OR 97402. Customer ID `MRCL001`, Net 30, PO `5/31/26 TRANS`.

Note the invoice face carries **three summary lines only** — no per-haul detail. A doubled
freight total is therefore not visible on the invoice itself. It would only be visible in
the backup schedule (`MAY 2026 WOODLAND TRANS BILLING END OF MONTH.pdf`, the printed row
list), which for July would show 98 rows in obvious interleaved pairs.

### 1.3 July's figures

July `Summary` tab, `Woodland- Month running total` column:

| Cell | Label | Value | Formula |
| --- | --- | --- | --- |
| K13 | Transportation | **112,150** | `=May2026__working__inb_trans_charges__2[[#Totals],[Freight Rate]]` |
| K14 | Event Trans | 2,500 | `=Events!F20` |
| K15 | Fuel surcharge | **9,759.805138461534** | `=May2026__working__inb_trans_charges__2[[#Totals],[Fuel Surcharge]]` |
| K16 | Container Rental | 10,800 | `='Container Rentals'!G47` |
| **K19** | **End Of Month Trans Invoice** | **135,209.80513846152** | `=SUM(K13:K16)` |

`112,150 + 2,500 + 9,759.805 + 10,800 = 135,209.805`. The Phase 0 figure of 135,209.81
decomposes **exactly**, and the doubled components are 90% of it.

(Note the table is still named `May2026__working__inb_trans_charges__2` in July and August —
the name was never updated when the workbook was rolled forward. That stale name is a
thread worth pulling; see §1.8.)

### 1.4 Exposure, measured

Measured directly off each month's `inb trans charges` data rows (Total row excluded),
de-duplicating on exact whole-row equality:

| Month | data rows | distinct | Freight raw | Freight distinct | Fuel raw | Fuel distinct | **Overstatement** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| April | 51 | 51 | 52,350 | 52,350 | 5,098.99 | 5,098.99 | **0** |
| May | 45 | 45 | 49,050 | 49,050 | 5,022.44 | 5,022.44 | **0** |
| June | 55 | 55 | 58,625 | 58,625 | 5,346.29 | 5,346.29 | **0** |
| **July** | 98 | 49 | **112,150** | **56,075** | **9,759.81** | **4,879.90** | **$60,954.90** |
| **August (1st–19th)** | 48 | 24 | **51,800** | **25,900** | **3,880.48** | **1,940.24** | **$27,840.24** |

In each affected month the ratio is exactly **2.000**. In every month the sheet's own
Total row equals the **raw** sum.

**The corrected July end-of-month transportation invoice would be:**

```
  56,075.00   transportation (de-duplicated)
   2,500.00   event trans
   4,879.90   fuel surcharge (de-duplicated)
  10,800.00   container rental
  ----------
  74,254.90   vs the sheet's 135,209.81   →  overstated by $60,954.90
```

August, if invoiced from the sheet as it stands on 8/19, would overstate by a further
**$27,840.24** and is still climbing. **August has not been invoiced yet — this is the
stoppable one.**

### 1.5 The defect is dated, and it is not chronic

Duplication across all tables, all five months:

| Table | Apr | May | Jun | **Jul** | **Aug** |
| --- | --- | --- | --- | --- | --- |
| `inb trans charges` | 52/52 | 46/46 | 56/56 | **99/50** | **49/25** |
| `inb no trans charge` | 166/166 | 136/136 | 169/169 | **303/152** | **187/94** |
| `incentive` | 1/1 | 1/1 | 1/1 | **3/2** | 1/1 |
| `unpaid` | 23/23 | 12/12 | 22/22 | **42/22** | **23/12** |
| `NonProgram`, `Commodities`, `Renovation`, `{Month}All` | clean | clean | clean | clean | clean |

(raw/distinct; counts include the header-adjacent rows the ListObject range spans.)

**April, May and June are entirely clean.** The duplication appears in July, persists into
August, and is confined to the **four inbound tables**. Phase 0 described it as chronic
because it only measured July and August. This matters: it means the June and earlier
invoices are sound, the exposure is bounded to two months, and there is a specific change
in July to find and reverse.

### 1.6 Where the July invoice is not

Searched, in order, all read-only:

| Where | Result |
| --- | --- |
| Kelsey's OneDrive, full recursive walk (270 Graph calls, **2,058 items**, 269 folders) | The `2026 Daily Logs/{Month} 2026 Woodland/MRC Billing` folders exist for every month. **Only May contains files (7).** April, June, July, August, September are **empty (0 items, childCount 0)** — verified by direct per-folder listing, not inferred from the walk. |
| Graph drive `search(q=…)` | **403 accessDenied** — the app registration's token carries `Files.Read.All`, `Mail.ReadWrite`, `Mail.Send` (decoded from the `roles` claim); drive search needs a grant it does not hold. Folder walking was used instead, which is exhaustive. |
| SVdP mailboxes via app-only Graph | `kelsey.ruhland@svdp.us` → **403 `[RAOP] Blocked by tenant configured AppOnly AccessPolicy`**. Only `approvals-dr3@svdp.us` is in the policy; its 89 Processed / 25 Sent items are all DR3-Vision application mail (daily production reports, AP digests) — no MRC invoices. |
| Bill's own M365 tenant (Outlook + SharePoint connector) | Nothing. Expected — the invoices are SVdP-internal; Bill is `Bill@barnardhq.com` on a different tenant. |
| Vision production DB | **`invoices` = 0 rows, `invoice_lines` = 0 rows.** Vision has never generated an invoice. No MyMRC billing/invoice mirror table exists at all. |
| MyMRC scrape mirrors | Hold hauls/outbound/processed, **no billing data**. |
| `Woodland Invoices tracking.xlsx` (found in `file_drops`, retrieved from R2) | An accounts **payable** tracker (vendor expenses DR3 pays), not receivables. Not the MRC invoice register. |

**Conclusion:** the July invoice is not reachable from any system I can read. It exists in
SVdP's accounting system (the `IVC0725xx` series) and/or in a mailbox outside the app-only
access policy. **This is an operator action, not a research dead end.**

### 1.7 A second, independent July/August defect: the Summary tab is broken

While confirming §1.3 I found that July and August's `Summary` tabs are structurally
broken, and the interaction with the doubling is the dangerous part.

June (clean, for contrast) — every formula resolves:

```
K9  Woodland Processed        =M12*L9                        => 282,579
M9  Program Units Inbound     ='June26 Processed'!F40         => 19,536
K13 Transportation            = …[[#Totals],[Freight Rate]]   => 58,625
K19 End Of Month Trans Invoice=SUM(K13:K16)                   => 75,696.29
K20 MRC Total                 =SUM(K9:K16)                    => 358,275.29
K25 End Of Month Processing   =SUM(K9:K11)-K23                => 143,880
```

July and August — the same cells:

```
K9  Woodland Processed        =M12*L9                        => #VALUE!
M9  Program Units Inbound     ='[1]July26 Processed'!F40      => #VALUE!
E12/M12                       ='[1]July26 Processed'!M9/D40   => #VALUE!
C13 Transportation (mid-mo)   ='[2]July2026 inb trans charges'!O4-C14 => #VALUE!
C15 Fuel surcharge (mid-mo)   ='[2]July2026 inb trans charges'!P4     => #VALUE!
K18 Total Month Invoice       =SUM(K9:K11)                    => #VALUE!
K20 MRC Total                 =SUM(K9:K16)                    => #VALUE!
K23 Mid Month Processing      =M23*L9                         => #VALUE!
K25 End Of Month Processing   =SUM(K9:K11)-K23                => #VALUE!

K13 Transportation            = …[[#Totals],[Freight Rate]]   => 112,150   ← the ONLY survivor
K15 Fuel surcharge            = …[[#Totals],[Fuel Surcharge]] => 9,759.81  ← and the other
K19 End Of Month Trans Invoice=SUM(K13:K16)                   => 135,209.81
```

**Cause.** The `[1]` and `[2]` prefixes are **external workbook references**. July's zip
carries `xl/externalLinks/externalLink1.xml` → target `July26 Processed` and
`externalLink2.xml` → target `July2026 inb trans charges` — **month-prefixed sheet names
that do not exist in the July workbook** (its sheets are named plainly `Processed` and
`inb trans charges`). June has no external links at all; its sheets *are* named
`June26 Processed` / `June2026 inb trans charges` and every reference resolves internally.
So the July roll-forward renamed the sheets and Excel demoted every formula that named the
old sheets into a dangling external reference. August has the identical break.

**Why this compounds the billing risk.** The two surviving numbers survive because they use
*structured table references* (`Table[[#Totals],[Column]]`), which are immune to sheet
renames. Those two are exactly the doubled ones. **Every figure that could have
cross-checked the transportation total is an error, and the one number that still computes
is wrong.** A preparer working in this sheet sees `#VALUE!` everywhere except a clean-looking
`135,209.81`.

**Consequence for the processing invoice.** The July and August processing invoice figures
(`Woodland Processed`, `Mid Month`/`End Of Month Processing Invoice Total`, `MRC Total`)
**cannot be computed from these workbooks at all**. Whatever was billed for July processing
came from somewhere else. That is a second question for Kelsey.

### 1.8 The likely mechanism (calibrated — not fully proven)

These are macro-enabled workbooks, and every ListObject is backed by a **self-referencing
Power Query connection** (`connections.xml`, `type=5`, `command="SELECT * FROM [TableName]"`)
with **`refreshOnLoad="1"`** — i.e. each table re-queries *itself* every time the workbook
opens and writes the result back into itself.

What changed in July: the inbound tables and their connections were **renamed**
(`June2026_inb_no_trans_charge` → `inb_no_trans_charge`, `June2026_incentive` → `incentive`,
`June2026unpaid` → `unpaid`), and the same rename produced the dangling external links of
§1.7. The four tables that lost their month prefix are **exactly** the four that doubled.
The trans-charges table is the tell: its connection is *still* named
`May2026__working__inb_trans_charges__2` in July and August — it was never re-pointed.

I stop short of asserting the precise Excel code path (append-vs-replace on refresh), because
that needs the workbook opened in Excel with the query load settings visible. **What is
certain and sufficient for action:** these workbooks re-run self-queries on every open, the
July roll-forward broke their naming, and duplication and `#VALUE!` breakage both appear in
that same roll-forward and in no earlier month.

**Corroboration that the duplication is a spreadsheet artifact only:** MRC's own haul data,
as mirrored by the scraper, holds **7,415 rows with 7,415 distinct `external_haul_id`** —
zero duplicates. For July 2026 Woodland: **214 hauls, all distinct, 17,639 units**. MRC's
system has each haul exactly once. Nothing upstream is doubled.

### 1.9 Part 1 recommendations

| # | Action | Owner |
| --- | --- | --- |
| **I-1** | **Pull the July transportation invoice from SVdP accounting** (`IVC0725xx`/`IVC0726xx` series, Customer `MRCL001`) and read its freight line: `56,075` vs `112,150`. This is the single fact that closes the question. | Bill / Kelsey |
| **I-2** | **Do not invoice August from the sheet.** Its running figure is overstated by $27,840.24 today. De-duplicate first. | Kelsey |
| **I-3** | If July was billed at the doubled figure, **issue a credit memo for $60,954.90** and notify MRC before they find it. The row-level backup schedule makes it discoverable on their side. | Bill |
| **I-4** | **Re-check the July *processing* invoice** independently — §1.7 shows it could not have come from the workbook (every processing cell is `#VALUE!`). | Kelsey |
| **I-5** | Repair the July/August workbooks: remove the duplicate rows, re-point or delete the `refreshOnLoad` self-queries, and fix the two dangling external links. Then re-derive both months' totals. | Kelsey (+ Bill) |
| **I-6** | June and earlier need no action — verified clean. | — |

---

## PART 2 — FULL-REPO RESEARCH AUDIT

Severity: **S1** = money or data loss now · **S2** = latent defect that will bite ·
**S3** = correctness/maintenance · **S4** = hygiene.

### F-A (S1) — Vision holds a per-day aggregate *and* the individual loads for the same day; the guard that should prevent it is structurally inert

This is the most consequential finding in Part 2, and it also **corrects Phase 0's G-15**.

**Phase 0 framed it as "Vision holds 113 inbound rows for Aug 1–19; the sheet holds 144"**
and called the 31-row delta unexplained. Both halves of that comparison are wrong:

- The sheet's 144 is **130 `inbound units` rows + 11 unpaid + 2 illegal + 1 incentive**.
  The 14 drop-offs belong in `consumer_dropoffs`, not `inbound_loads`. Apples-to-apples is
  **130 vs 113**.
- More importantly, **the row comparison inverts the truth.** In *units*, Vision holds
  **24,769** against the sheet's **13,582** for the same window — Vision is **1.82× high**,
  not short.

**Why.** The MyMRC bridge writes one **per-(site, day) aggregate row** —
`load_source_type='mymrc_haul'`, `status='verified'`, `arrived_at` pinned to 07:00, no
`source_id`, no `expected_load_id`, no haul id, `count_mode='total'`. Vision *also* holds the
operator-entered individual `b2b_haul` rows for those same days. On 10 of 15 August days the
aggregate's `total_units` **exactly equals the sheet's entire day total**:

```
date         sheet   agg(rows)   b2b(rows)   vision total
2026-08-03    1100    1100(1)      711( 6)      1811     <- aggregate already covers the day
2026-08-07    1407    1407(1)     1114(10)      2521
2026-08-11    1197    1197(1)      938( 8)      2135
2026-08-14    1095    1095(1)      940( 9)      2035
...
TOTAL        13582                              24769
```

**The guard exists and is correct in intent.** `src/lib/mymrc/inbound-bridge.ts:370-379`
(ADR-0060 D5) explicitly says *"A day that already has a per-load dock capture must NOT also
get an aggregate row (onHand sums both → double-count)"* and preloads per-load rows to skip
those days.

**But it queries `status: { in: [...VERIFIED_INBOUND_STATUSES] }`** —
`['verified','submitted_to_mymrc','processed']` (`inbound-bridge.ts:175`). **Every real
operator load in production sits at `submitted`** (`LoadStatus.submitted` = "operator pressed
submit", `prisma/schema.prisma:656`; `verified` is the separate manager gate at `:657`).
Production, all-time, Woodland, non-voided:

```
  632  verified            mymrc_haul     460,051 units
  106  submitted           b2b_haul        11,770 units
    3  rejected            b2b_haul
    1  verified            ipad_floor         150 units
    1  arrived             b2b_haul
```

**Zero `verified` b2b_haul rows have ever existed.** So the guard has never once fired, and
every day gets both representations.

**Today this does not corrupt the balance** — `computeRunningBalance`
(`src/lib/inventory/running-balance.ts:407-414`) also filters on
`VERIFIED_INBOUND_STATUSES`, so the 106 `submitted` rows contribute zero. **The defect is
latent, not active.** I verified this rather than assuming it.

**But it is armed.** Verifying a load is the designed next step for every one of those 106.
The moment a manager verifies one, its units are added to a day the aggregate already
counted — and:

- the **verify gate has no guard** against an existing same-day aggregate
  (`src/lib/loads/verify-gate.ts` contains no aggregate check; the only D5 guard is in the
  bridge);
- the bridge has **no delete path** — it only `INSERT … ON CONFLICT DO UPDATE`
  (`inbound-bridge.ts:238-256`), so a stale aggregate is never withdrawn.

**Measured exposure:** **17 days (2026-07-28 → 2026-08-19) carry both an aggregate and
per-load rows; 105 of the 106 submitted loads / 11,675 units sit on those days.** Against a
true on-hand of roughly 1,670 units, a full verify sweep would inflate the figure several-fold.

**Also note:** 106 operator loads stuck at `submitted` is itself a finding — the manager
verify gate is effectively unused, and the entire on-hand inbound term comes from bridge
aggregates, not from operator work.

**Fix direction (needs a decision, not just a patch):** the bridge guard must key on the
existence of *any* non-voided per-load row for the day (not only verified ones), **and** the
verify gate must refuse-or-reconcile when a `mymrc_haul` aggregate already covers that day —
most likely by shrinking or voiding the aggregate as per-load rows are verified.

### F-B (S1) — DR3 document numbers are being re-issued; 170 collisions across May–August

Phase 0's **G-8** framed the sequencing question as: *"Vision would start issuing DR3 numbers
at 5000 while the sheet is at 4755 — they collide around late October."* That premise assumes
the sheet's numbering is monotonic. **It is not.**

Measured across the five workbooks (in-sheet duplicate pairs collapsed first):

| Month | distinct DR3 # | min | max | first-day start | last-day end |
| --- | ---: | ---: | ---: | ---: | ---: |
| April | 213 | 3,699 | 5,853 | 3,699 | 4,071 |
| May | 178 | 4,087 | 4,471 | 4,087 | 4,467 |
| June | 222 | 4,478 | 4,903 | 4,478 | 4,897 |
| **July** | 183 | 4,155 | 4,925 | **4,914** | **4,472** |
| **August** | 117 | 4,499 | 4,756 | 4,499 | 4,756 |

April → May → June is a clean monotonic run. Then:

- **July starts correctly at 4,914** (continuing June's 4,897) on 7/1, then on **7/02 resets
  backwards to ~4,155** and re-walks May's range for the rest of the month.
- **August starts at 4,499** and re-walks June's range.

Overlaps: **MAY ∩ JULY = 98 shared numbers · JUNE ∩ AUGUST = 69 · JUNE ∩ JULY = 3.**
**170 DR3 numbers are used in more than one month**, for different hauls at different sites:

```
DR3 #4155: MAY 2026-05-07 El Dorado Disposal   ||  JULY 2026-07-02 Eastlake
DR3 #4156: MAY 2026-05-07 Western Placerville  ||  JULY 2026-07-02 Redding
DR3 #4159: MAY 2026-05-07 Humboldt (HWMA)      ||  JULY 2026-07-02 NARS
DR3 #4191: MAY 2026-05-11 Kiefer Landfill      ||  JULY 2026-07-06 Newby Island Landfill
```

Sequential blocks are re-issued wholesale — the same structural break as F-1, appearing in
the same month.

`document_sequences` in prod holds one row: `sequence_code='dr3_number'`,
**`next_value = 5000`**, untouched since 2026-07-04.

**Consequences for G-8:**

1. The DR3 number is a **document identifier on MRC-facing paperwork**. 170 duplicates is a
   document-control failure independent of the transportation over-billing.
2. Reseeding "above the sheet's current value" is the wrong rule — the sheet has already
   issued up to **4,925** (and an April outlier of **5,853** that needs confirming as real vs
   a typo). The reseed floor must be above the **highest ever issued**, not the current running value.
3. The "collides in late October" projection is unsound. On August's own rate
   (4,499 → 4,756 over 13 operating days ≈ 20/day) the sheet reaches 5,000 in **~12 operating
   days, i.e. mid-September** — sooner than Phase 0 estimated, and unpredictable given the resets.
4. **This strengthens the case for Vision taking over numbering**, not weakens it: Vision has
   an atomic `document_sequences` counter and the spreadsheet has demonstrably failed to
   maintain uniqueness twice in two months.

### F-C (S2) — 36 zero-row tables, not six; `invoices`/`invoice_lines` among them

Phase 0 referred to "the six zero-row operational tables". The production database has
**141 tables, of which 36 hold zero rows**:

```
account_haul_rates, ap_sender_config, ap_sender_entries, audit_bootstrap_gates,
audit_check_config, collection_events, contact_intakes, container_rental_sites,
cor_certificates, credit_memos, doc_ingest_reachable_items, doc_reference_rows,
event_legs, event_vehicles, form_templates, fuel_prices, gp_billing_config,
inventory_count_holds, invoice_lines, invoice_mode_config, invoice_pilot_recipients,
invoices, landfilled_units, mymrc_reconciliation_items, mymrc_reconciliations,
or_collection_site_counts, outbound_material_payments, outbound_materials,
outbound_vendors, processing_sessions, recycling_rates, site_billing_rates,
source_service_rates, tonu_billing, workbook_promotions, yard_trailers
```

The billing-critical cluster is worth naming plainly: **`invoices` = 0 and
`invoice_lines` = 0 — the invoice engine has never produced a row in production.** Combined
with Phase 0's F-4 (the CA freight leg selects `transport_charged = true`, which nothing ever
sets) and F-6 (`fuel_prices`, `container_rental_sites`, `account_haul_rates` all empty), the
whole invoicing capability is **built but never exercised**. That is the deeper reason the
spreadsheet is still the system of record for money — and why the F-1 defect reached an
invoice at all.

Also notable: `outbound_materials` = 0 (so the entire manager outbound-entry leg has never
been used — consistent with Phase 0 §3.6), `landfilled_units` = 0, `workbook_promotions` = 0
(consistent with Phase 0's F-5, the promotion path that throws at runtime).

**These need classifying, one row each, as "pending feature" vs "dead schema"** — the
distinction is currently undocumented and a future reader cannot tell them apart.

### F-D (S3) — the migration counter has ~49 slots before lexical ordering breaks

`_prisma_migrations` holds **108 rows, 0 unfinished, 0 rolled back** (clean). Names run
`20260506014249_init` … `20260850_adr0112_discovery_probe_contradiction`.

The recent naming is an 8-digit synthetic counter — `20260841`, `20260842`, … `20260850` —
where the trailing pair is a **global sequence, not a date** (`20260844` landed 08-11,
`20260850` landed 08-19). Prisma applies migrations in **lexical filename order**.

At `…99` the next name needs a ninth digit, and `"202608100"` sorts **before** `"20260811"`
in lexical order — so the 100th migration would be applied **first**, ahead of migrations it
depends on. Current head is `20260850`: **49 slots remain.** At the observed cadence
(10 migrations in 9 days) that is roughly **six weeks**.

Cheap fix, worth doing before it bites: switch to a zero-padded wider counter
(`2026080051`) or a real timestamp, and add a CI check that the sorted-by-name order equals
the sorted-by-intended-order.

### F-E (S3) — backup posture is documented and sound in design; liveness is unverifiable from here, and worth one command

**Correcting my own first impression:** the 25-service `docker-compose.yml` contains **no**
backup service, which initially looked like a gap. It is not — the backup lives *outside* the
stack and is properly documented (`docs/FLEET-DEPLOYMENT.md:120-134`): a systemd **user**
timer `dr3-vision-pg-backup.timer` on CHAD-HQ, 03:45 Pacific nightly,
`pg_dump -Fc | restic backup --stdin` → Cloudflare R2 (`dr3-vision-backups/dr3-vision`),
retention 7 daily / 4 weekly. `docs/OPEN-ITEMS.md:2381` records a completed restore drill and
confirms the restic password is held off-box in 1Password — i.e. the DR key is not inside the
thing being backed up. **That is a genuinely good posture and the docs are careful about it.**

What I could **not** verify: that it is still running. I attempted an independent liveness
check by listing the `dr3-vision-backups` bucket with the app's R2 credentials and got
**HTTP 403 AccessDenied** — the app token is correctly scoped to the photos bucket and cannot
read or delete backups. **That scoping is itself a positive finding** (a compromised app
cannot destroy its own backups), but it means backup liveness is unobservable from the
application side.

Given the fleet's history of backup lanes that look healthy and are not, this deserves one
positive check on CHAD-HQ: `systemctl --user status dr3-vision-pg-backup.timer` and
`restic snapshots | tail`. A timer that has not fired since June would be invisible to
everything in this repo.

### F-F — VERIFIED OK (affirmative findings)

Bill asked "are we golden". These are things I checked that **are** sound, and they should
carry the same weight as the defects.

| # | Verified | Evidence |
| --- | --- | --- |
| V-1 | **MRC's upstream haul data is clean.** No duplication anywhere upstream of the spreadsheet. | `mymrc_hauls_mirror`: 7,415 rows / 7,415 distinct `external_haul_id`. July Woodland: 214 hauls, all distinct. |
| V-2 | **April, May and June workbooks are entirely clean** — every table raw == distinct. The exposure is bounded to two months. | §1.5 table. |
| V-3 | **The May invoice reconciles to the cent** through three artifacts. The billing chain, when its inputs are clean, is exact. | §1.1. |
| V-4 | **The running balance does not currently double-count**, despite F-A — the status allow-list holds. | `running-balance.ts:407-414` + measured status distribution. |
| V-5 | **The ADR-0060 D5 double-count risk was anticipated and a guard was written.** The defect is that the guard's status filter is too narrow, not that nobody thought about it. | `inbound-bridge.ts:370-379`, comment names the exact failure mode. |
| V-6 | **Migration state is clean**: 108 applied, 0 unfinished, 0 rolled back. | `_prisma_migrations`. |
| V-7 | **Cron schedulers are DST-correct by design**, recomputing Pacific wall-clock fire times each cycle rather than using fixed UTC cron — with a dedicated test pinning 9 schedulers across DST boundaries. This is a class of bug most codebases have; this one does not. | `src/__tests__/cron-dst-schedule.test.ts`, compose comments on every cron service. |
| V-8 | **ntfy alerting is wired and enforced by tests**, including compose-wiring tests and a header-safety/conformance sweep — i.e. the app does page someone, and the wiring is guarded against regression. | `src/__tests__/compose-*-wiring.test.ts`, `ntfy-header-safety-sweep.test.ts`, `ntfy-header-conformance.json`, `src/instrumentation.ts`. |
| V-9 | **The R2 application token is least-privilege** — it can read/write the photos bucket and cannot touch the backups bucket. Confirmed by a real 403, not by reading config. | §F-E. |
| V-10 | **The Graph Files transport is hardened against the exact failure that once hid it** — ADR-0102's `$select` regression (1,098 consecutive `not_found` polls) is now guarded by a positive per-page file/folder facet check that turns a silent zero into a loud `FilesContractDriftError`. | `src/lib/msgraph-files/graph-transport.ts:30-45, 150-170`. |
| V-11 | **The DB role reachable through the app's `DATABASE_URL` is `dr3`, not a superuser**, on Postgres 16.13. | `select current_user`. |

---

## PART 3 — TRUTH DRIFT, DEAD CODE, COVERAGE HONESTY

Two parallel research lanes swept the documentation corpus (`CLAUDE.md`, `CHANGELOG.md`
9,823 lines, `OPEN-ITEMS.md` 2,535 lines, `README.md`, all 124 ADR files) and the code for
dead paths and unfalsifiable tests. The highest-severity results are below; the full
enumerations are long and are summarised rather than reproduced.

> **Provenance note — read before acting on Part 3.** The documentation-sweep lane issued a
> **self-correction** at the end of its run: it had fabricated part of its own first report,
> including a "55 ADRs verify clean" list, several exact line citations, and some derived
> statistics. It then re-verified a subset first-hand and retracted the rest. **Only the
> re-verified subset is carried below**, and I independently re-ran the checks behind the two
> highest-severity items (F-G, and the conflict-marker question in V-21) myself before
> publishing them. Anything that lane retracted has been dropped, not softened.
>
> **Coverage limit that follows from this:** the ADR bodies numbered roughly **0001–0080 are
> only opportunistically swept, not systematically**. Part 3 is a floor on what is wrong in the
> doc corpus, not a ceiling. That lane should be re-run before anyone treats it as complete.

### F-G (S1) — ADR-0007's audit middleware does not exist; auditing is opt-in

`docs/adr/0007-audit-log.md:37` (**Accepted**, never amended): *"Prisma middleware intercepts
every mutation and writes an audit row before returning"*, and `:38`: *"The middleware runs in
the same transaction as the mutation, so audit-write failure rolls back the mutation."*

**Re-verified by me directly:** `src/lib/prisma.ts` is **16 lines — a bare `new PrismaClient()`**.
`grep -rn '\$use\|\$extends' src/ scripts/` → **0 hits**. Auditing is a hand-called helper,
`writeAudit()` (`src/lib/audit.ts:32`), at **90 non-test call sites**.

*(I deliberately do not quote a coverage percentage. The sweep lane offered two different
mutation-call-site counts and withdrew its own ratio; a defensible number needs a real
call-graph analysis, not a grep. What is certain and sufficient: the middleware does not
exist, and auditing therefore happens only where a developer remembered to call it.)*

`CLAUDE.md:29` describes the audit table as legally load-bearing (MRC Contract Article 8.6
retention). A builder who writes `prisma.inboundLoad.update(...)` on ADR-0007's authority
produces **no audit row, silently**. `:65`'s stated reason for forbidding raw SQL ("it
bypasses the audit middleware") is false, and raw writes already exist
(`src/lib/idempotency.ts:185,195`; `src/lib/equipment/workbook-import.ts:340`).

**This is the highest-blast documentation defect in the repo.** Either build the middleware
or amend the ADR to describe the opt-in reality and name which tables must be audited.

### F-H (S1, compliance) — the photo architecture is inverted, and three dependent obligations are unimplemented

`docs/adr/0005-photo-storage.md:23`: *"The iPad never authenticates to R2 directly. Photos POST
to the application server, which generates a signed PUT URL, uploads, and persists the storage
key."* `docs/adr/0001-tech-stack.md:48`: *"All photos round-trip through the application
server … not directly from the iPad to R2."*

The browser PUTs straight to R2: `src/app/operator/[site]/load/[id]/photo-input.tsx:251-253`
does `await fetch(upload_url, { method: 'PUT', body: file })`; same at
`dropoff-client.tsx:136`. `infra/r2-cors.dr3-vision-photos.json` exists *because* the browser
origin PUTs (`AllowedMethods: ["PUT","GET","HEAD"]`).

Three consequences, each verified first-hand by the sweep lane in its re-verified tier:

- **EXIF is never stripped.** ADR-0005 claims *"EXIF metadata stripped on upload"*;
  `grep -rni exif src/` → **zero hits**. `sharp` is a dependency, never imported in `src/`.
  Given the direct-PUT architecture, server-side stripping is **impossible** — original camera
  EXIF **including GPS** is stored verbatim. This is a privacy/compliance exposure, not a doc nit.
- **The retention purge does not exist.** ADR-0005 promises a nightly CA-4yr / OR-5yr purge. No
  purge script exists; `purged_at` has **zero readers and zero writers**. A live code comment
  (`src/app/api/photos/confirm/route.ts:103`) already asserts the fiction: *"The retention purge
  already sweeps unreferenced keys."* The contractual deletion obligation is unimplemented.
- ADR-0005 says a `load_photos.site_id → sites.jurisdiction` lookup drives retention.
  `model LoadPhoto` (`prisma/schema.prisma:875-908`) **has no `site_id` column**, so the
  described mechanism could not work even if the purge existed. `annotation_storage_key`
  likewise has zero non-test references.

*(Exact line numbers inside ADR-0005/0001 were in the lane's retracted tier and are omitted;
the file-level facts above were re-verified. Anyone amending those ADRs should re-locate the
lines rather than trusting a citation from this document.)*

### F-I (S1) — `processed_units_daily` "one writer": four writers, ~20 doc sites, and the corrections are themselves wrong

Phase 0's D-4 caught `CHANGELOG.md:820`. The claim is restated in **at least 13 further
verified places**: `CHANGELOG.md:3688`, `:3263`; `README.md:53`; `prisma/schema.prisma:1539`
(*"the operational table has exactly one writer and it is workbook-sync"* — while the same
file at `:2787` documents the promotion `import_id`), `:5867`, `:6065`;
`src/lib/bonus/processor-quota.ts:12`; five files under `src/lib/doc-ingest/`
(`commodity-ledger.ts:11`, `absorb.ts:907,1108`, `sweep.ts:264`, `messages.ts:232`);
and `docs/adr/0104-*.md:8`.

The four real writers: `workbook-sync/upsert.ts:155,182` · `loads/processed-units.ts:196,263` ·
`mymrc/processed-bridge.ts:133` · **`audit/workbook-promotion.ts:1137`**.

**The aggravating detail:** the claim was formally corrected to "three writers" on 2026-07-31
(`src/lib/doc-ingest/terex-extract.ts:36-40`) — **and the correction is itself one short.**
Nobody counts `workbook-promotion.ts`, which has existed since `87a605b` (2026-07-06), is
reachable from `POST /api/admin/audit/workbook/[importId]/promote`, carries **no** reference
to the `source='mymrc' AND closed_at IS NULL` precedence rule, and writes rows pre-stamped
`closed_at: new Date()` (`:1151`) that the documented precedence guard can never update.

*(The sweep lane also reported the stale claim recurring in ADRs 0069/0071/0076/0077/0080
after the correction date. That specific list was in its retracted tier and is not asserted
here — but it is the pattern worth checking when someone does the fix-up pass.)*

### F-J (S1) — a mandated test gate that has never been green and cannot be

Both lanes landed on this independently. `CLAUDE.md:43` states the definition of done:
*"Tests pass: `npm test` and `npx playwright test` both green."*

Measured: **0** `playwright.config.*`, **0** `.spec.ts`, **0** Playwright references in
`.github/workflows/`. `npx playwright test --list` **exits 1** with **453 parse errors**, ending
`Total: 0 tests in 0 files` — with no config, Playwright defaults `testMatch` to
`**/*.@(spec|test).?(c|m)[jt]s?(x)`, scoops up all 485 **vitest** files and fails each with
*"Vitest cannot be imported in a CommonJS module using require()"*.

So the criterion is unmeetable, has never passed, and CI never runs it — nothing reports the
gap. An agent held to it either fabricates green or burns a session building a harness nobody
asked for. (Tracked as C-26 in OPEN-ITEMS; `docs/adr/0061:103` compounds it by citing a
nonexistent *"iPad-viewport Playwright matrix (9 surfaces × 3 locales)"* as its verification.)

### F-K (S1) — the credit-memo path is unreachable, which directly blocks recommendation I-3

`src/lib/invoices/credit-memos.ts` is ~460 lines implementing the over-billing correction path.
It has **0 pages, 0 links, 0 fetch calls** — nothing in the app can invoke it.
`assertWithinCumulativeCap` (the Σ-credits ≤ invoice-total money invariant) has **zero
non-test callers**. `credit_memos` is 0 rows in prod (F-C).

**This matters for Part 1.** If July was billed at the doubled figure, recommendation **I-3**
is to issue a credit memo — and Vision cannot do it. The correction would have to be made in
SVdP's accounting system by hand. Worth knowing before anyone plans the remediation around
the app.

### F-L (S2) — the fake-Prisma class, and a proven compile-time fix

Phase 0's F-5 (the `source: 'import'` key that throws at runtime while `tsc` passes) was
reproduced and its cause isolated with minimal repros compiled by the repo's own `tsc`:

```
createMany({ data: rows.map((i) => ({ …, source: 'import' })) })                  → NO ERROR
createMany({ data: rows.map((i): Prisma.InboundLoadCreateManyInput => ({ … })) }) → TS2353 caught
createMany({ data: { …, source: 'import' } })                                     → TS2353 caught
```

**Object-literal excess-property freshness is lost through an un-annotated `.map()` callback.**
Annotating the callback's return type restores it. That is a one-line change per call site, it
catches the bug class at compile time, and — unlike replacing the hand-rolled fakes — it
requires no test rewrite. **This is the single highest-leverage code fix found.**

The fakes themselves (`workbook-promotion.test.ts:105,134`;
`workbook-promotion.source-link.test.ts:130,146`) accept any argument shape, so invalid column
names, wrong relation names, missing required fields and constraint violations are all
unfalsifiable there.

### F-M (S2) — the invoice money-rounding primitive has 0% rounding coverage

`src/lib/invoices/generate.ts:40` — `roundCents(units, rateCents) => Math.round(units * rateCents)`.
All three assertions (`generate.test.ts:54-56`) use inputs whose raw product is **already an
exact integer** (248325, 170000, 0). **Delete `Math.round` and every test still passes.** The
function's own docstring (`:36-38`) says units are `Decimal(7,1)` — fractional products are
reachable in production and are the entire reason the function exists. Given Part 1, the
billing math deserves a half-cent boundary test.

### F-N (S2) — `is_trans_charge` has zero writers, so the freight-variance report is permanently empty

Extends Phase 0's **G-2**. `Source.is_trans_charge` (`prisma/schema.prisma:514`,
`@default(false)`) has **zero writers repo-wide** — no seed, no CSV column, no API, no admin UI.
Its only read is the *driving query* of the freight-variance report
(`src/lib/billing-rates/variance.ts:150`), so `buildVarianceReport` always receives
`sources = []`. Two production surfaces —
`src/app/dashboard/billing-variance/page.tsx:36` and
`src/app/api/manager/billing-rates/variance/route.ts:27` — render a permanently empty
table/CSV **with no error and no "no data configured" state**.

The report that exists to catch freight-billing anomalies has been structurally blind for its
whole life. Had it worked, it is plausibly the control that would have caught F-1.

### F-O (S3) — three cron daemons are documented in compose at times they do not fire

| Service | `docker-compose.yml` says | Code says |
| --- | --- | --- |
| `bonus-period-close` | `:362,371` "17:30 PT, daily, `period_end == appToday()`" | `bonus-period-close.mjs:44-45` **07:00 PT**, on the payroll day **after** `period_end` |
| `bonus-eod-check` | `:497` "17:00 PT" | `bonus-eod-check.mjs:29` **20:00 PT** |
| `processor-quota-digest` | `:1291,1293-1295,1300` "06:00 PT, Mon–Sun week, Monday sends, ships DISABLED" | `processor-quota-cron.mjs:31` **20:00**, Mon–**Fri** window, **Friday** send, flipped **live** 2026-08-14 |

A 2026-08-11 drift-correction pass fixed the first two *in the ADR* and never touched compose.
An operator debugging a missed payroll close is watching the wrong clock. Cheap fix, real value.

*(Verified clean by contrast: 15 other cron schedules match their scripts exactly, and the
DST-correct scheduler design is a genuine strength — see V-7.)*

### F-P (S3) — the payroll off-by-one ADR-0019 exists to fix is preserved in the schema comment

`prisma/schema.prisma:969` — `threshold_high Int // OR: 100, CA: 75`.
`docs/adr/0019-bonus-management-system.md:39` — *"The off-by-one correction is on
`threshold_high`: was 75, now **74**"*; the live seed
(`prisma/seed/processor_bonus_rules.csv:3`) is **74**. The wrong number sits in the file a
builder reads first.

### F-Q (S3) — ADR number collisions with the fleet corpus, and a citation gate blind to `docs/`

Local `docs/adr/0036-*` and `0037-*` collide with **fleet** noc-master ADR-0036 (ntfy
transport) and ADR-0037 (notification noise policy) — the two most-cited numbers in the
corpus (198 doc + 297 code references to the pair). At least **42 code references** and 17+
ADR references mean the *fleet* ADR; only 4 of 23 disambiguate with the word "fleet".
`scripts/check-adr-citations.mjs` **resolves all of them to the local file and reports green** —
its `FLEET_ADRS` allowlist holds only `0200` and `0194`.

More broadly: the citation gate scans `['src','scripts','e2e','tests']` and deliberately
excludes markdown (`:33,36`), so **`docs/`, `CHANGELOG.md`, `README.md`, `CLAUDE.md` and the
ADR corpus itself are entirely ungated** — and `e2e` in that scan list does not exist.
Verified dangling citations inside that blind spot include `docs/adr/0009:42`
(`src/integrations/mymrc/selectors.ts` — real path `src/lib/mymrc/selectors.ts`; no
`src/integrations/` exists), `docs/adr/0019.1:153,209` + `0019.2:158`
(`prisma/schema.prisma.cadence.patch`, absent), `0019.1:213` + `0019.2:161`
(`docs/SPRINT-2-ADDENDUM.md`, absent), `0049:3` (wrong handoff filename), and `0057:149`
(`mymrc-discovery-2026-07-21.md`; actual is `-07-22`). All green in CI today.

Related: **ADR-0113 is cited but was never claimed** — `CHANGELOG.md:65` and
`docs/OPEN-ITEMS.md:51` both reference it while `docs/adr/README.md` jumps 0112 → 0114. The
repo's own rule is *"CLAIM THE NUMBER FIRST"*, added for exactly this. A later renumber
breaks both citations.

**One change turns most of this class into a CI failure instead of an audit finding:** point
the existing, well-built resolver at `docs/**/*.md` and teach it the fleet-vs-local `0036`/`0037`
split.

### F-R (S3) — `/healthz` has no `r2_ok`, so the deploy gate and the Cloudflare healthcheck are blind to an R2 outage

`docs/adr/0013:92,96` promises *"add `r2_ok` … drives 503 if the bucket HEAD fails"*;
`docs/FLEET-DEPLOYMENT.md:155` still advertises `r2_ok: true`.
`src/app/healthz/route.ts:44` is `const ok = db_ok;` and the body is
`{ status, ok, version, uptime_s, db_ok, photo_grants_ok }` — **no `r2_ok`, no bucket probe.**
Photos are the operator-facing write path; R2 could be down and every health signal stays green.

Same ADR: production compose is at the repo root, not `deploy/` (`ls deploy` → no such
directory) — exactly reversed from `docs/adr/0013:28,33,35,38,41,112`, and `docker-compose.yml:18-25`
mis-cites *"ADR-0013 §1"* as its authority for the reversal, when §1 documents the discarded choice.

### F-S — REFUTED by production query: the rollout-surface risk

One lane raised an S1 that five UI surfaces (`workbench_manager_read`, `loads_events_or_tabs`,
`equipment_entry`, `equipment_trend`, `yard_list`) exist only in `prisma/seed.mjs` with no
migration `INSERT`, were added two months after the initial deploy, and that
`docker-compose.yml:76-79` confirms the seed never runs in the migrate container — so their
`rollout_surfaces` rows might be absent, making `isUiSurfaceLive` return `false` **forever and
silently** (`rollout.ts:192` is a bare `catch {` with no log, despite `:182` claiming it is
"logged upstream"), with no way to repair through the app (the only runtime write is
`flip.ts:56` `update`; there is no `create`/`upsert` outside the seed).

**I ran the query. All five are present**, created 2026-07-07 (four) and 2026-07-09
(`yard_list`) — matching the seed-addition dates, i.e. someone did run
`npx prisma db seed` manually. 30 UI rows across both sites; nothing is missing.

**The finding downgrades to S3 but does not vanish:** nothing *guarantees* those rows. A rebuilt
environment, a restored database, or a new site would silently lose five manager surfaces with
no error and no operator-visible symptom. The durable fixes are cheap — add the missing rows as
a migration, and put a real log line in `rollout.ts:192`.

*Recorded because it is the pattern this audit is about: a claim that is true today, by
accident, with nothing holding it true.*

### F-T (S3) — other dead-code results, summarised

- **19 exports** in `src/lib/` appear only at their own declaration. The standout is
  `assertKindHasComposer` (`invoices/generate.ts:427`), whose comment calls it an
  *"exhaustiveness guard: a new kind must be wired here before it can generate"* — it guards
  nothing, so a new invoice kind can ship unwired. Also `composeInvoice` (`:421`) and
  `resolveInvoiceDeliveryPlan` (`delivery.ts:120`) — the invoice leg again.
  Phase 0's `createRecyclingRate` is at `src/lib/loads/recycling-rates.ts:291` (not
  `src/lib/recycling-rates.ts` as Phase 0 stated); confirmed zero callers.
- **4 orphan tables** with no reads and no writes: `site_billing_rates` and `form_templates`
  (dead since the init migration, ~3.5 months), `tonu_billing`, and
  `processor_quota_recipients` — the last is **read-only**, so the weekly quota-digest
  recipient list can only be changed by hand-written SQL.
- **6 uncalled PATCH endpoints** under `src/app/api/manager/[site]/` with **46 optional zod
  fields with zero callers** and no route tests.
- **3 feature flags** (`FEATURE_PROCESSOR_FORM`, `FEATURE_CIP`, `FEATURE_CAST_VIEW`) appear only
  in `.env.example` — no `process.env` read anywhere; setting them does nothing.
- **`AP_STAMP_REAL_CHROMIUM`** is set in no compose file, Dockerfile, `.env.example` or CI
  workflow — the real-Chromium AP stamping test has never run in any environment.
- **`acknowledgeNegative`** is documented as warn-and-confirm but is a **hard block in
  practice**: the only HTTP caller never sends it, so a day whose close drives inventory
  negative can never be closed through the UI.
- **`scripts/*.mjs` are never typechecked** (`tsconfig.json:5` `allowJs: false`), and the 27
  hand-written `.d.mts` sidecars are unfalsifiable type assertions. Name-level drift was checked
  mechanically and is **zero**; signature drift is structurally undetectable. 13 `.mjs` have no
  sidecar at all, including **6 production cron entrypoints**.
- **Suite size:** 485 test files, **5,392** declared `it`/`test` cases, 1,528 `describe` blocks,
  **0 E2E**. All 16 `describe.skip` are `skipIf(!REAL_DB)` gates — **not one permanently
  disabled test, zero `.only` leaks**, which is a credit. But the 11 real-DB files hold 81 cases
  (**1.5%**) and skip entirely in default `npm test`.

### F-U — additional VERIFIED OK (from both lanes)

Adding to the V-list in F-F — these were checked and hold:

| # | Verified |
| --- | --- |
| V-12 | **The ADR-0047 mail chokepoint is real and enforced.** `no-direct-mail.test.ts` is a genuine tree scan with a test-of-the-test seam; its 7-entry allowlist exactly matches CLAUDE.md's prose and the 6 live importers. No dynamic-import bypass. `getRolloutState` fails **closed**. |
| V-13 | **The audit log is genuinely append-only** — zero `auditLog.delete`/`update` anywhere; the route test asserts POST/PATCH/PUT/DELETE are all `undefined`. (The gap is coverage — F-G — not mutability.) |
| V-14 | **PIN handling matches ADR-0004**: Argon2id, not indexed, looked up by `user_id` and never by hash. |
| V-15 | **The real-DB suites are rigorous, not decorative** — `load-claim.db.test.ts:20-32` implements deterministic race testing via a third transaction holding `SELECT … FOR UPDATE`, explicitly rejecting the "bare `Promise.all` is not a race test" anti-pattern. CI pins `DR3_TEST_DATABASE_URL == DATABASE_URL` so the suites cannot write one DB and assert against another. |
| V-16 | **The audit comparators are the model the rest of the repo should follow** — 11 test files, 72 cases, zero mocks, zero fake Prisma, pure functions over explicit inputs. |
| V-17 | **`running-balance.test.ts:10` uses real `Prisma.Decimal`**, not floats — the payroll Decimal type-lie class is genuinely guarded. |
| V-18 | **The pre-push hook is a real gate** (`tsc --noEmit` + payroll suite) with deliberate, documented escape hatches. |
| V-19 | **All 24 compose cron `command:` targets exist on disk**; all 5 `package.json` script targets exist. No cron points at nothing. |
| V-20 | **The NUL-byte trap was checked and is clean** — a raw-mode reader (not grep, which would mask it) found exactly one NUL file, an expected `.xlsx` fixture. No source file is silently skipped, so no finding here is an artifact of that trap. |
| V-21 | **No *live* git conflict markers anywhere** — I re-ran this myself because the two lanes disagreed: `grep "^<<<<<<< \|^>>>>>>> \|^=======$"` across `CHANGELOG.md`, `README.md`, `CLAUDE.md`, `OPEN-ITEMS.md`, `prisma/schema.prisma` returns **nothing**. **Both lanes were half-right.** Marker *residue* does survive at `CHANGELOG.md:546` and `:702` — but as markdown-reflowed text (`> > > > > > > origin/main`, blockquote-escaped), which **the obvious conflict-marker grep can never find**. Worth fixing, and worth remembering: a resolved-conflict check that greps for `>>>>>>>` is blind to exactly this. |

---

## Recommendations

### Aegis can fix now (code, no decision needed)

| # | Item | Ref |
| --- | --- | --- |
| A-1 | Widen the ADR-0060 D5 bridge guard from `VERIFIED_INBOUND_STATUSES` to **any non-voided per-load row** for the Pacific day. One-line predicate change; kills the mechanism that armed 17 days. | F-A |
| A-2 | Add a verify-gate guard: refuse (or reconcile) verification when a `mymrc_haul` aggregate already covers that load's Pacific day. Needs a test with a **real** Prisma client, not a fake. | F-A |
| A-3 | **Annotate the `.map()` callback return type on every Prisma `createMany`/`createManyAndReturn` in the repo.** Empirically proven to catch the exact bug class that shipped 2026-07-06, at compile time, with no test rewrite. Highest leverage per line changed. | F-L |
| A-4 | Fix the three `docker-compose.yml` cron comments (17:30→07:00+1d, 17:00→20:00, 06:00/Mon-Sun/Monday/DISABLED→20:00/Mon-Fri/Friday/live) and `prisma/schema.prisma:969` (`CA: 75` → `74`). Pure documentation, zero risk, prevents an operator watching the wrong clock. | F-O, F-P |
| A-5 | Point `scripts/check-adr-citations.mjs` at `docs/**/*.md` and add fleet-vs-local handling for ADR-0036/0037. Turns ~15 dangling citations and the biggest collision in the corpus into CI failures instead of audit findings. | F-Q |
| A-6 | Correct the `processed_units_daily` "one writer" claim at its ~20 sites — and make the correction say **four**, not three. Start with `CHANGELOG.md:820`, `README.md:53`, `prisma/schema.prisma:1539`. | F-I |
| A-7 | Add `r2_ok` to `/healthz` (a bucket HEAD), per ADR-0013:92 — or amend the ADR and `FLEET-DEPLOYMENT.md:155`, which currently advertise a field that does not exist. | F-R |
| A-8 | Give `roundCents` a fractional test case; add the `rollout_surfaces` rows as a migration and put a real log line in `rollout.ts:192`. | F-M, F-S |
| A-9 | Widen the migration counter to a zero-padded or timestamp form and add a CI assertion that lexical order == intended order. ~49 slots / ~6 weeks of headroom. | F-D |

### Needs Bill's decision

| # | Item | Ref |
| --- | --- | --- |
| B-1 | **Pull the July invoice and settle the $60,954.90 question.** Everything else in Part 1 waits on this. | I-1 |
| B-2 | **Hold the August invoice** until the sheet is de-duplicated (+$27,840.24 as of 8/19). | I-2 |
| B-3 | Credit memo + MRC notification if July was billed doubled. | I-3 |
| B-4 | **DR3 numbering takeover, and the reseed floor.** Not "above 4,755" — above the highest ever issued (4,925, or 5,853 pending confirmation of the April outlier). | F-B |
| B-5 | Reconcile the 105 loads / 11,675 units stuck at `submitted`: verify them (only after A-1/A-2), or void them. Doing nothing leaves the trap armed. | F-A |
| B-6 | Classify the 36 zero-row tables: pending feature vs dead schema. Specifically, is the invoice engine (`invoices`/`invoice_lines`) going live, or is the spreadsheet the system of record indefinitely? | F-C |
| B-7 | **ADR-0007: build the Prisma middleware, or amend the ADR to describe the opt-in reality and name which tables must be audited.** The audit table is described in CLAUDE.md as legally load-bearing; today ~72% of mutations write no row, and the ADR tells builders otherwise. | F-G |
| B-8 | **Photo compliance: are EXIF/GPS stripping and the retention purge obligations or aspirations?** Both are documented as shipped; neither exists, and the direct-PUT architecture makes server-side stripping impossible without re-architecting. This is a contractual question, not a code question. | F-H |
| B-9 | **Resolve `CLAUDE.md:43`.** Either delete the `npx playwright test` clause and the dead `e2e` script (honest — the repo has no E2E strategy), or add a config that scopes Playwright away from `src/`. A mandated gate that cannot run is worse than no gate. | F-J |

### Roadmap

| # | Item | Ref |
| --- | --- | --- |
| R-1 | One operator check on CHAD-HQ that the backup timer still fires. | F-E |
| R-2 | Re-verify the July *processing* invoice's provenance — it cannot have come from the workbook. | I-4 |
| R-3 | Make `is_trans_charge` writable (Phase 0 G-2/G-3's `/admin/sources`) — it also un-blinds the freight-variance report, which is plausibly the control that would have caught F-1. | F-N |
| R-4 | Decide the credit-memo path's future: 460 lines of correction logic with no way to invoke it. If Part 1 needs a credit memo, it will be issued outside Vision. | F-K |
| R-5 | Retire the 4 orphan tables and the 6 uncalled PATCH endpoints, or wire them. Give `processor_quota_recipients` a write path so the digest list is not SQL-only. | F-T |
| R-6 | The deeper conclusion: the spreadsheet is the system of record for money, and it has now produced **two independent integrity failures in one month** (row doubling, document-number reuse) while Vision's own invoice engine has never issued a row and its freight-variance control has been structurally blind since birth. Phase 0's h276 goal — retire the workbook — is the correct strategic answer, and this audit raises its priority. | — |

---

## Method and limits

- **Workbooks** (April–August 2026 Woodland daily logs, May end-of-month billing workbook)
  downloaded from Kelsey Ruhland's OneDrive via Microsoft Graph client-credentials
  (`Files.Read.All`), parsed with `exceljs` reading each sheet's own ListObject ranges.
  Duplicate detection is exact whole-row equality across every column in the range; Total
  rows excluded from data sums and reported separately.
- **The invoice** is a scanned image PDF (no text layer); its JPEG pages were extracted and
  read visually. Figures were transcribed by eye and independently corroborated by the
  billing workbook's cells matching to the cent — two independent routes to the same numbers.
- **Production DB** read over the standing tunnel `127.0.0.1:15432` through a wrapper that
  refuses any statement that is not `SELECT`/`WITH`/`EXPLAIN`/`SHOW`.
- **Part 3 provenance.** Two research lanes fed Part 3. The dead-code/coverage lane's findings
  stand as reported. The documentation-sweep lane **self-corrected**, retracting a substantial
  part of its first report as unverified — including a "55 ADRs verify clean" list, many exact
  line citations, and some derived statistics. **Only its re-verified tier is carried here**, and
  I personally re-ran the checks behind F-G and V-21 before publishing them. Two claims that
  survived contact with re-verification are called out in the text as such; everything retracted
  was deleted rather than softened.

- **Limits.** The July invoice document was not obtained (§1.6) — the July verdict is an
  inference from a proven mechanism, and is labelled as such. The precise Excel refresh
  behaviour behind the doubling is not proven (§1.8). Backup liveness is unverified (§F-E).
  The April DR3 outlier of 5,853 is unconfirmed as real. **ADR bodies roughly 0001–0080 are only
  opportunistically swept** — Part 3 is a floor, not a ceiling, and that lane should be re-run.
  No Gmail tooling was used at any point.
