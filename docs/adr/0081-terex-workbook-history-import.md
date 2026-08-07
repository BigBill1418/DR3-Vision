# ADR-0081 — the TEREX workbook's own history, imported into the machine's own table

**Status:** Accepted, implemented (2026-08-07)

**Supersedes:** ADR-0079 Amendment 1 **D10** ("means never blend across the era") —
for the `entered`/`workbook` pair only. `legacy_derived` is still never blended.

**Builds on:** ADR-0079 (the table, its partial unique index, the cutover boundary,
per-day source honesty), ADR-0069 Amendment 2 (the same 40-sheet workbook, its two
maintenance logs, and the deliberate decision to leave the monthly tabs alone),
ADR-0077 (the machine is resolved by evidence; "not recorded" over a fake `0.0`;
non-human actors name themselves), ADR-0035 (clean-replay invariant).

---

## Context

ADR-0079 gave the Terex a table of its own and ADR-0079 Am.1 put the sheet era back
on the chart — as the **floor's** number, hatched and labeled, because that was the
only pre-cutover figure Vision held. It was never the only one that existed. The
machine's own daily units and its own hour-meter hours had been written down every
working day for nineteen months, by the people who run it, in Janette's spreadsheet.

Bill's directive, verbatim:

> "use the excel sheet to pull in the historical data - then STARTING TODAY you will
> just take in the data that JT enters here but ALL OF THAT DATA needs to be
> aggregated and displayed IN THIS PAGE."

**ADR-0069 Am.2 §3 was right to leave these tabs alone, and its reason has since
expired.** That amendment absorbed only the two maintenance logs and stated the
monthly tabs were `processed_units_daily` territory — a table with three writers
governed by a precedence rule (`source = 'mymrc' AND closed_at IS NULL`) that
nobody had re-derived. ADR-0079 moved the ground under that sentence: the machine's
units **and run hours** now live in `equipment_daily_throughput`, which is not
`processed_units_daily`, has no precedence rule to break, and has exactly one
writer to negotiate with — the manager. These tabs are that table's history.

### The artifact, verified byte-for-byte

`doc_sources` `8a0246e7-dbb0-4de2-a90f-ddc5d4b2de4b` — `TEREX.xlsx`, doc_class
`terex_maintenance_log`, site Woodland (`de9875a3-a09f-484f-aed1-2891ef544b87`).
Version `eed9d4cb-03c1-47cf-8ea6-081995fac4c4`, applied 2026-08-06,
`absorption_status = absorbed`, **490,670 bytes**, r2_key
`file-drops/doc-source-8a0246e7-…-36308cbc54e6/TEREX.xlsx`.

The bytes were fetched **from inside the cluster** — the workstation holds no R2
credentials, the same constraint ADR-0069 Am.2's one-off script records — and hashed:

```
sha256 36308cbc54e6269c95ec3915b63e661a4140402a873d8cd8cd479533cc14fa6b
```

byte-identical to the stored `content_sha256`. **40 sheets, 2,080 rows.** Every
figure in this ADR was measured against those bytes, not against a fixture.

### The five hazards

1. **There is no date column.** Not one of the 24 monthly tabs has a header that
   says "Date". The day is a bare day-of-month in an **unlabeled** leading cell
   (column A); the month and year live in cells of the title row
   (`Terex Operating Data | July | 2026`). Deriving the date from the row **ordinal**
   is the most attractive shortcut available and it is wrong — it survives every tab
   that happens to start on row 3 with day 1, then mis-dates everything after the
   first inserted or deleted line.
2. **Three decoy tabs wear byte-identical canonical headers:** `Aug25(1)`,
   `Template`, `Template (2)`. Header-shape matching — the technique
   `terex-extract.ts` correctly uses for the maintenance logs — **cannot** tell them
   from a real month. `Aug25(1)` is the dangerous one: a half-finished draft with
   real-looking operator notes, an instructional `Example` row, end-hour readings
   written into the day-hours column, and a "Total Hours Used" of **3,683.95 in a
   month that has 744**. All three carry the literal placeholders `MONTH`/`YEAR` in
   their title row.
3. **The 2024 tabs are four bespoke schemas.** `Sept24` puts its header on row 1
   (`Date | Processed | Received | Hrs Used`); `Oct24` has a doubled per-commodity
   layout with **three** separate `Hrs Used` columns; `Nov24` and `Dec24` are two
   further shapes, `Dec24` carrying `Start Time`/`End Time` **clock** times rather
   than hour-meter readings.
4. **Units are three columns.** `Pocket coil` + `Springs` + `Wood`, summed. Any one
   alone under-reports.
5. **Row counts vary 36–102, and the data block is not the sheet.** Below the days
   sit a totals row, a `*Key` legend (`G` / `PS` / `LOTO`), and on some tabs further
   analysis blocks. Columns A–G are identical on all 24 tabs; columns H+ are not —
   `Feb26` names its hours column `Day Total Hrs Used (max hours 10)` and inserts a
   `re-fuel` column, and the 2025 tabs carry one, two or three different
   per-commodity rate columns.

### What the run against the real file produced

All 24 monthly tabs extracted and reconciled:

```
tabs allowlisted: 24 (Jan25 … Dec26)      tabs skipped: 16
importable rows: 319                       duplicate dates: 0
date range: 2025-01-02 … 2026-07-24
skipped: 4 out_of_scope_2024 · 12 not_a_monthly_tab (incl. all three decoys)
```

**319, not 320** — see D1 and the fractional-unit cell.

---

## The import contract (R1–R6)

These are the six requirements the source cites by number.

| #      | Requirement                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **Every date comes from a CELL, and every row that cannot be resolved is counted.** Unresolvable rows (no day cell, day out of month, duplicate day, insane hours/units, fractional units) are capped at **10% of the day rows seen**; over that, the whole tab is skipped. `no_run_hours` is deliberately **not** counted as a failure — it is the normal shape of a weekend on a tab that pre-prints all 31 days, and folding it in would fail every correct tab. |
| **R2** | **Tab selection is an explicit 24-name ALLOWLIST, cross-checked against the tab's own title-row month and year.** An allowlist rather than a pattern, because every pattern that admits the 24 real tabs also admits `Aug25(1)`.                                                                                                                                                                                                                                    |
| **R3** | **The four 2024 tabs are excluded KNOWINGLY, by name.** The report says "out of scope for v1 (four bespoke 2024 schemas)" for those four and "not a monthly operating tab" for `diesel` — so a reader can tell somebody looked.                                                                                                                                                                                                                                     |
| **R4** | **The whole figure, and only this revision of it.** Units are all three commodity columns summed. The rows written are a **projection of one `doc_source_versions` revision**: the same revision twice is a no-op; a newer revision supersedes rather than accumulates.                                                                                                                                                                                             |
| **R5** | **Reconciled or nothing.** A month whose extraction disagrees with the workbook's own published totals stages the **whole** import — nothing is applied and the offenders are named.                                                                                                                                                                                                                                                                               |
| **R6** | **The preview is the same code path as the apply.** `apply: false` runs read, extract, reconcile and reports exactly what *would* change, writing nothing. A preview computed by different code is a preview of a different thing.                                                                                                                                                                                                                                 |

Nothing coerces. A row whose hours cell is blank, zero or unreadable is **skipped and
counted** — never defaulted to 8, and never inferred from `End Hours − Start Hours`.
That difference is exactly what the sheet's own formula already computes, and
re-deriving it would manufacture hours on the rows where the operator left the
formula un-filled on purpose.

---

## The two genuine findings — the defect is in the workbook, not in the import

R5 **hard-stopped** on two tabs. It was right to, and the investigation proved the
arithmetic error is in the source document.

### `March25` — the units total under-covers its own data by two rows

```
units SUM(B3:B30) / SUM(C3:C30)   ← stops at row 30
hours SUM(G3:G33)                 ← covers the whole block
published units 1483 + 57 = 1540
omitted:  row 31 (day 29) 131.75 coils
          row 33 (day 31) 157 coils
extracted 1540 + 131.75 + 157 = 1828.75
```

Hours reconciled **to the cent** and units were out by exactly **288.75**. That
asymmetry is the whole tell: one extractor, one tab, one formula covering the block
and one not.

### `Dec25` — both totals under-cover, by one row

```
units SUM(B3:B32)   hours SUM(G3:G32)   ← both stop at row 32
omitted: row 33 (day 31) — 182 coils, 7.45 hours
units 1675 + 182 = 1857        hours 67.99 + 7.45 = 75.44
```

1857 and 75.44 are exactly what the extractor read.

### The fix: reconcile over the range the workbook's own formula DECLARES

The totals cell's **formula text** is parsed (`SUM(B3:B30)` ⇒ rows 3–30) and the
extraction is summed over that same range. This is the true like-for-like question —
*did I read the same rows the same way Excel did?* — and it is **strictly stronger**
than the whole-tab compare:

- a cell mis-read **inside** the declared range still fails the check;
- the rows **outside** it are reported as a `coverageGap` finding, naming the row,
  the date, the units and the hours — not silently dropped.

The rows themselves are still imported. They are read correctly; the only thing
wrong is the workbook's published summary of them.

**The rejected alternative was widening the tolerance.** The ±0.5% relative
tolerance would have had to grow to roughly **19%** for both tabs to pass. That is
not a tolerance, it is a blindfold: at 19% a genuinely mis-resolved column on any of
the other 22 tabs sails through unremarked.

### A third finding: the one fractional-unit cell

`March25` day 29 reads **131.75 pocket coils** against an INTEGER column — the only
such cell in the workbook. `units_processed` is `INTEGER NOT NULL`, so the row cannot
be stored as written, and every way of storing it anyway is a lie: **132 invents a
quarter of a mattress, 131 discards one**, and either puts a number nobody wrote into
a table whose whole premise is that the figures are the operator's own. It is skipped,
counted, and named in the report so a manager can enter the day deliberately. That is
the difference between 320 rows and **319**.

### Why the OVERVIEW checks are ADVISORY

`OVERVIEW2026` row 12 computes July's "High" units/hour with **`MINIFS`** — a
provable formula bug in the workbook. Making every published cell a hard gate would
let the workbook's own bug block a correct import. OVERVIEW-derived checks are
therefore reported and never blocking. The one OVERVIEW check that is *not* advisory
in spirit is the hours cross-reference, and it earns that by pinning something the
totals-row resolution can get wrong on its own: `='Jan 2026'!G34` is the workbook
naming **which cell** it calls the month's total.

---

## D1 — Extraction: an allowlist, and a date from a cell

Tab selection is the 24-name allowlist (R2), each entry carrying the month it **must**
turn out to be, cross-checked against the month and year the tab's own title row
claims. Both halves are load-bearing. The allowlist stops `Aug25(1)`; the
cross-check stops a tab renamed or re-purposed upstream from importing a month's data
onto the wrong month. All three decoys fail **both** — they say `MONTH`/`YEAR`
literally.

The names are copied from the live workbook, not generated, because they are not
systematic: `Jan 2026` carries a space; `July25` and `March25` spell the month out;
`Jan25` and `Jul26` do not.

Columns are resolved **by label regex on the header row itself**, never by fixed
index and never from a normalized `headers[]` array — normalization drops leading
blanks, and the day column's header **is** blank, so an array-resolved layout lands
every column one to the left, putting the day onto Pocket Coil and the units onto the
hour meter. The day column is then identified as the unlabeled column immediately
left of Pocket Coil, so the whole block can shift right without breaking.

The data block is bounded by the **day cells**, never by a row count: scanning stops
at the first non-day row *after* at least one day row, which lands exactly on the
totals row and never walks into the `*Key` legend or the analysis blocks below it. A
non-day row **before** the first day row does not stop the scan — `Aug25(1)` opens
with an instructional `Example` row and a real tab could acquire one.

`import.date-never-ordinal` inserts a row mid-month and proves every date downstream stays put.

## D2 — Storage: a `source` COLUMN on the existing table, not a sibling table

An `equipment_daily_throughput_import` table was considered first and rejected on the
strength of **ADR-0079's own uniqueness guarantee**. The invariant that matters is
ONE LIVE FIGURE PER MACHINE PER DAY, and it is enforced by

```sql
CREATE UNIQUE INDEX equipment_daily_throughput_machine_day_key
  ON equipment_daily_throughput (equipment_id, throughput_date)
  WHERE voided_at IS NULL;
```

A sibling table puts the imported day **outside that index**. Both sources could then
hold 2026-07-15, **nothing in the database would object**, and "JT's entry wins" would
degrade from a constraint into a convention that every future read path has to
remember. That is the identical failure shape ADR-0079 D2 rejected for
`equipment_events`. Keeping the rows in one table means the conflict is a real
conflict, adjudicated by the database, once.

Two columns carry the whole design:

- **`source`** — `'manager' | 'workbook_import'`, DB-CHECKed. Free text would let a
  typo (`workbook-import`, `Workbook_Import`) become a third source the JT-wins guard
  silently does not protect and the display silently does not draw.
- **`import_version_id`** — which revision produced the row. Without it a re-import
  cannot tell "already done" from "the file changed", and the only options left are
  additive duplication or blowing away the table.

A second CHECK pairs them: a `workbook_import` row must carry a version; a `manager`
row must not.

The migration (`20260833_adr0081_throughput_source`) is **purely additive** per
ADR-0035 — two defaulted/nullable columns, two CHECKs, one partial index, every
statement idempotent. Every pre-existing row becomes `'manager'`, which is what all of
them are: the only write path that existed before this migration was ADR-0079's
manager entry. Nothing is backfilled by the migration; the import is a separate,
audited, reconciled operation. The `20260833_` prefix sorts after ADR-0079's
`20260831_` and leaves `20260832_` to the parallel ADR-0080 stream.

## D3 — JT wins, adjudicated IN THE DATABASE

```sql
INSERT INTO "equipment_daily_throughput" (…)
VALUES (…)
ON CONFLICT ("equipment_id", "throughput_date") WHERE "voided_at" IS NULL
DO UPDATE SET … 
WHERE "equipment_daily_throughput"."source" = 'workbook_import'
```

The `ON CONFLICT … WHERE` infers ADR-0079's **partial** unique index; the
`DO UPDATE … WHERE source = 'workbook_import'` makes a manager's row
un-overwritable. When that predicate is false the statement affects **zero** rows —
the day is simply left as the manager wrote it, and that zero is the signal the
importer reads to report `rowsYieldedToManager`. A non-zero count there is the
feature operating, not a failure.

**Why not a read-then-write.** A `SELECT` for existing manager rows followed by an
`UPDATE` is a TOCTOU: a manager saving that day in the half-second between the two
statements would have their entry **silently replaced by the sheet**. `ON CONFLICT …
WHERE` is evaluated against the row the index actually found, inside the same
statement, holding the same lock. `import.jt-wins-on-conflict` deletes the `WHERE`
clause and proves the red names the manager's real number.

**The asymmetry IS Bill's instruction.** The import cannot overwrite a manager; a
manager overwrites an import through the ordinary ADR-0079 write path. "Starting
today JT takes over" — history is a floor to build on, not a ceiling.

### `import_version_id` carries no foreign key, deliberately

`doc_source_versions` is `ON DELETE CASCADE` from `doc_sources`. A real FK would force
one of three bad outcomes:

| FK action     | What it does to production                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `RESTRICT`    | makes removing a doc source impossible, for a reason a reader would never guess                                   |
| `CASCADE`     | lets **removing a document DELETE PRODUCTION THROUGHPUT**                                                          |
| `SET NULL`    | strips provenance off rows still claiming `source = 'workbook_import'`, breaking the CHECK and hiding them from supersession |

A bare id matches the convention this table family already uses for exactly this
reason (`applied_by`, `discarded_by`, `voided_by` are all bare). Provenance is a claim
about history, and history does not get re-pointed when a row elsewhere is deleted.
The DB CHECK pairs `source` with `import_version_id` instead.

### Idempotency and supersession (R4)

Same version ⇒ **no-op**, detected before any write. Newer version ⇒ the prior
import's rows are deleted and this revision's reinserted, **in one transaction**,
scoped to `source = 'workbook_import'` so manager rows are untouchable here as well
as in the upsert. Never additive.

**A hard DELETE, not a soft-void.** An imported row is a *projection of a document
revision*, not a person's claim, so replacing it is a re-projection rather than a
reversal. Soft-voiding would leave one dead row per day per revision forever,
invisible behind the partial unique index and reachable by nothing. The **batch** is
audited — one audit row naming the version, the counts, the yielded days, the date
range and the tabs extracted — so the supersession itself stays append-only history.
One audit row for the batch, not 319: the unit of decision is the revision, and a
per-row trail would bury the one fact a reader needs under a day-by-day replay of a
document that is itself archived and re-readable.

### Actor, and the table that is never written

`actor_label = 'system:workbook-import'` with `created_by` **NULL** — per ADR-0036 /
ADR-0077 actor discipline, the import names itself rather than borrowing a `users.id`
and writing a false claim into a trail hard rule #6 means we can never take back out.

`processed_units_daily` is **never** written. Not "not currently" — there is no code
path. The importer's database surface is declared structurally rather than as
`PrismaClient`, so the type is the complete list of what an import may touch and
`processedUnitsDaily` is conspicuously not on it; widening the blast radius means
editing that type in the same diff. `import.never-writes-processed-units-daily`
passes a fake whose `processedUnitsDaily` throws.

## D4 — `workbook` is a FOURTH per-day source, drawn as itself

`ThroughputSource` becomes `'entered' | 'workbook' | 'legacy_derived' | 'not_recorded'`.
Provenance travels with the number from the first read (`RecordedDay.isWorkbook`)
rather than being re-inferred, and re-inferred differently, at each render site.

`isWorkbook` is a boolean rather than the raw string on purpose: consumers ask one
question — *is this the sheet or a person?* — and a boolean cannot be compared against
a mis-spelled literal. It defaults to **manager** for anything that is not the imported
sheet, which is the conservative direction, because manager rows are the ones the
import must never overwrite.

There is **no tie-break between `entered` and `workbook`, and none is needed**:
ADR-0079's partial unique index allows exactly one live row per (machine, day), so a
day is recorded by one source or the other and never both. The precedence is enforced
by the database (D3), not by a branch. A tie-break here would be dead code dressed up
as a safeguard.

**Units per run-hour is REAL for workbook days.** The sheet carries true hour-meter
hours (`Day Total Hrs Used`), so the rate divides by hours the machine actually ran —
the same denominator an entered day gets. Legacy days still get **no** rate:
ADR-0079 Am.1 §5 stands, and reviving the assumed-8h figure would publish a
fabricated denominator.

## D5 — Means blend `entered` with `workbook`; this SUPERSEDES ADR-0079 Am.1 D10

**ADR-0081 supersedes ADR-0079 Amendment 1's D10 era-purity rule — "means never blend
across the era" — for the `entered`/`workbook` pair.** The rationale is Bill's
directive: *"ALL OF THAT DATA needs to be aggregated and displayed IN THIS PAGE."*

This is not a reversal, and the argument for why it is safe is the important part.

**Am.1 was RIGHT to refuse blending.** What it refused to blend was the **whole
floor's** output (1,000–1,250 units/day at Woodland) with **one machine's** (a few
hundred). Those are different physical quantities, so an average across them describes
nothing while sitting on the machine's line.

**The workbook figure is not that.** It is the machine's own units against the
machine's own hour-meter hours — the identical measurement JT now types into Vision,
taken from the sheet Vision is replacing. **Like blends with like.** Refusing would
leave a nineteen-month history sitting next to a 7-day average that ignores it, which
is precisely the blank-history complaint Am.1 itself was written to fix.

So the distinction that matters for every statistic on the page is not
manager-vs-sheet, it is **machine-vs-floor** — `isRealMachineSource()`.

Three things are unchanged:

- **`legacy_derived` is STILL never blended.** `legacyMean7`/`legacyMean30` are
  unchanged, run over a disjoint legacy-only series, and are rendered only *on* legacy
  days so the dashed line stops at the boundary.
- The cutover boundary stays the stored constant `TEREX_CAPTURE_CUTOVER_ISO`
  (Am.1 D7). A workbook row does not move it.
- The structural legacy treatment stays (Am.1 D9). **Solid still means a real machine
  figure.**

**A blended mean is never shown without saying what is in it.** Every point carries
`mean7Composition` / `mean30Composition` and a label — e.g.
`"7-day mean — 5 sheet, 2 entered"`. The disclosure travels **with** the figure, so no
render site can show the mean without being able to show its composition.

## D6 — The admin labels stop saying "Equipment" — without making a label lie

Bill: *"this tile is only for terex data - and in the admin area the tile STILL say
'Equipment' can you finally fix all of this please… populate this terex page with
relevant data metrics for this equipment."*

Honoured, but not by renaming a generic surface to a specific machine.
**`/admin/equipment` is a genuine cross-site asset master**: `listEquipment()` queries
the whole `equipment` table across **both** sites over all five categories
(`vehicle`, `forklift`, `baler`, `terex`, `other`), and it is the AP approver's fleet
picker. Calling that page "Terex" would be a false label on the one screen whose job
is the rest of the fleet.

| Surface                                              | Label                          | Why                                                             |
| ---------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `/admin` hub tile + `/admin/equipment` page title    | **"Terex & equipment assets"** | leads with Terex per Bill's intent; stays truthful about the rest |
| `/dashboard/[site]/equipment` launcher tile          | **"Terex"** (site-derived)      | this one **is** Terex-only                                       |
| `equipment.navLink` message key                      | **deleted**                     | zero consumers — deleted rather than renamed                     |
| `siteMachineLabel()`'s `'Equipment'` fallback        | **left alone**                  | see below                                                        |

**`siteMachineLabel()`'s fallback was deliberately not touched.** It is *site-derived*
(ADR-0077 Am.1): a `terex`-category, active, unmerged row that the Terex invoices
actually resolve to. A site with no Terex therefore keeps the generic name **honestly
instead of advertising a machine it does not have**, and a Terex arriving at Eugene
tomorrow renames that site's surface with no code change. The literal is also
load-bearing as a sentinel in three call sites.

**The dashboard equipment page's description was FALSE and is corrected.** It read
*"Throughput is derived from the daily processed-units close — the same number billing
bills from; nothing is entered twice."* Every clause of that stopped being true when
ADR-0079 landed: throughput is captured, not derived; it is not billing's number; and
the whole point is that it **is** entered separately, because the floor's close cannot
tell one machine from the floor.

---

## Alternatives considered

**A sibling `equipment_daily_throughput_import` table.** Rejected — it puts the
imported day outside ADR-0079's partial unique index, so "one live figure per machine
per day" and "JT wins" both degrade from database constraints into conventions every
future read path must remember. See D2.

**Widening the reconciliation tolerance until `March25` and `Dec25` passed.**
Rejected — it would have needed roughly **19%**, which is not a tolerance but a
blindfold. Range-aware reconciliation removes the confound without removing the check.
See "The two genuine findings".

**Coercing the 131.75 cell to an integer.** Rejected — 132 invents a quarter of a
mattress, 131 discards one, and either writes a number nobody wrote into a table whose
premise is that the figures are the operator's own. Skipped, counted, named.

**Pattern-matching tab names, or matching on header shape.** Rejected — every pattern
that admits the 24 real tabs also admits `Aug25(1)`, and header-shape matching (correct
for the maintenance logs in ADR-0069 Am.2) cannot tell the three decoys from a real
month because their headers are byte-identical.

**Deriving the date from the row ordinal.** Rejected — it survives every tab that
starts on row 3 with day 1, then silently mis-dates everything after the first
inserted or deleted row. `import.date-never-ordinal` exists to keep it rejected.

**Inferring run hours from `End Hours − Start Hours` when the day-hours cell is
blank.** Rejected — that difference is exactly what the sheet's own formula computes,
so re-deriving it manufactures hours on precisely the rows where the operator left the
formula un-filled on purpose.

**A real foreign key on `import_version_id`.** Rejected on all three available
actions; `CASCADE` would let deleting a document delete production throughput. A DB
CHECK pairs `source` with `import_version_id` instead. See D3.

**A read-then-write "does a manager own this day?" guard in the importer.** Rejected
as a TOCTOU — a manager saving that day mid-import would be silently overwritten by
the sheet. The guard belongs in the statement.

**Soft-voiding superseded import rows instead of deleting them.** Rejected — one dead
row per day per revision, forever, invisible behind the partial unique index and
reachable by nothing. The batch audit keeps the supersession append-only.

**Importing the four 2024 tabs by writing one extractor that "handles" all four
schemas.** Rejected for v1 — writing an extractor for four shapes it was never
measured against is how a wrong number gets a confident label. Filed as an open item.

**Making the OVERVIEW checks hard gates.** Rejected — `OVERVIEW2026` row 12 uses
`MINIFS` where it means `MAXIFS`, so the workbook's own bug would block a correct
import.

**Leaving the means entered-only (keeping Am.1 D10 intact).** Rejected — it would
leave nineteen months of the machine's own history sitting beside a 7-day average that
ignores it, which is the blank-history complaint Am.1 was written to fix. The
technical case for blending is that `entered` and `workbook` are the same physical
quantity; `legacy_derived` still is not, and still is not blended.

---

## Consequences

- The Terex page gains **319 days of the machine's own units and its own run hours**,
  2025-01-02 → 2026-07-24, drawn as real machine figures rather than as the floor's
  proxy. Units-per-run-hour is real on every one of them.
- **JT's entries always win.** The import can never overwrite a manager's row; a
  manager always overwrites an imported one. The count of days the import yielded is
  reported on every run.
- Trailing means now blend `entered` with `workbook` and **always carry their
  composition** (`"7-day mean — 5 sheet, 2 entered"`). A consumer that renders `mean7`
  without `mean7Label` is showing a blended figure without saying what is in it.
- **`legacy_derived` days are unchanged** — hatched, labeled floor-wide, no rate, never
  blended. Where a workbook day now exists for a pre-cutover date, it **replaces** the
  legacy bar for that day, because a real machine figure beats a floor proxy on either
  side of the boundary (Am.1 D8's "entered always wins", extended to `workbook` by D4).
- **The workbook has two arithmetic defects and one un-storable cell**, all in
  Bill/Janette's copy, all named with exact ranges and figures (OPEN-ITEMS). Vision
  reports them; it does not repair them.
- **The four 2024 tabs are out of v1.** The history starts 2025-01-02, and the report
  says so by name rather than by silence.
- Re-importing the same revision is a no-op; a newer revision replaces the prior
  import's rows wholesale inside one transaction. Nothing accumulates.
- Deleting the `doc_sources` row for `TEREX.xlsx` will **not** delete the throughput
  rows, by design — they keep a dangling `import_version_id` and remain a truthful
  record of what was read. The provenance points at a version that no longer exists,
  which is a weaker claim than the alternative of deleting production data.
- `/admin/equipment` remains the cross-site asset master and now says so. The only
  surface renamed to "Terex" outright is the one that is actually Terex-only.

---

## References

- `docs/adr/0079-terex-daily-throughput-is-captured-not-derived.md` — the table, the
  partial unique index, the cutover boundary, and Am.1 D10 (superseded here for the
  `entered`/`workbook` pair).
- `docs/adr/0069-amendment-2-terex-maintenance-absorption.md` — the same 40-sheet
  workbook, the two maintenance logs, and §3's deliberate exclusion of the monthly tabs.
- `docs/adr/0077-terex-canonical-record-and-the-downtime-that-was-never-there.md` —
  identity by evidence, "not recorded" over a fake `0.0`, non-human actor labels,
  `siteMachineLabel()`.
- `docs/adr/0035-migration-ordering-clean-replay-invariant.md` — why the migration is
  purely additive and idempotent.
- `src/lib/doc-ingest/terex-monthly-extract.ts` — extraction, the allowlist, the five
  hazards, R1–R5.
- `src/lib/equipment/workbook-import.ts` — the write, R4/R5/R6, the JT-wins statement.
- `src/lib/equipment/throughput.ts` — `ThroughputSource`, `isRealMachineSource()`,
  the combined-real-series means and their composition labels.
- `src/lib/equipment/daily-throughput.ts` — `WORKBOOK_IMPORT_SOURCE`, `RecordedDay`.
- `prisma/migrations/20260833_adr0081_throughput_source/migration.sql`.
- `docs/OPEN-ITEMS.md` — the 2024 tabs, the two SUM-range defects, the fractional cell,
  the `MINIFS` bug.
