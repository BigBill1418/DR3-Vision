# ADR-0069 Amendment 2 — TEREX maintenance absorption, preview-then-confirm

**Status:** accepted, implemented (2026-07-31)
**Builds on:** Am.1 (trailer absorption), ADR-0067 Am.8 (header detection)

## 1. Why this one stages and the trailer list did not

`Estimated cost`, `Actual Repair Cost` and `Amount Credited` are real dollars.
The absorption contract says money-touching extraction is **preview-then-
confirm**: rows land `staged`, the totals are shown, a human accepts. The trailer
list carries weights and dates, so it lands directly. This does not.

That rule already existed. What this amendment adds is the case that proves it
was worth having.

## 2. The finding: absorbing this document naively doubles the money

The real workbook has **40 sheets**. Two are maintenance logs:
`Maintenance Log 2025` and `Maintenance Log2026`. They are _not_ two years of
data. Measured against the actual R2 object:

|                        | events (distinct) | actual repair total |
| ---------------------- | ----------------- | ------------------- |
| `Maintenance Log 2025` | 55                | **$77,067.94**      |
| `Maintenance Log2026`  | 80                | **$77,067.94**      |
| shared                 | 55                |                     |
| only in 2025           | **0**             |                     |
| only in 2026           | 25                |                     |

The 2025 sheet is a **strict subset** — a stale snapshot of the same cumulative
log. The trailer extractor's rule of "absorb every sheet that resolves" is
correct for a one-sheet workbook and **catastrophically wrong here**: it would
report **$154,135.88**, exactly double.

So this extractor **de-duplicates across sheets** and reports what it removed,
and the preview screen states the de-duplication in words — because a reader who
sees two maintenance-log tabs will reasonably expect ~$154k, and the smaller
number is only believable if the screen explains itself.

Running the finished extractor over the real 40-sheet file:

```
sheets scanned: 40
treated as maintenance logs: Maintenance Log 2025, Maintenance Log2026
events: 80   duplicatesRemoved: 57   undated: 16
totals: estimated $0 · actual repair $77,067.94 · credited $4,025.36
```

## 3. The other 38 sheets are deliberately untouched

They are 28 monthly operating tabs (`Jan 2026` …: per-day pocket coil / springs /
wood, machine hours, units per hour), pivot tabs (`OVERVIEW2026` at 57 columns,
`OVERVIEW2025`), derived rollups (`Combined Totals`, `Combined Costs Per Coil`,
`Annual Cost`), two blank `Template`s, a duplicate `Aug25(1)`, and `diesel`.

Two independent reasons:

- **The summary tabs are derived from the monthly ones.** Absorbing a source and
  its own rollup double-counts by construction — the same defect as §2, one level
  up.
- **The monthly tabs carry processed units per day.** That is
  `processed_units_daily` territory. Extracting them here would create another
  source of the same operational figure.

  **Correction (2026-07-31):** this ADR originally said "whose sole writer is
  workbook-sync". That is wrong. `processed_units_daily` has THREE writers — the
  super-admin entry route, the MyMRC processed bridge, and workbook-sync —
  governed by a PRECEDENCE rule (`source = 'mymrc' AND closed_at IS NULL`), not by
  exclusivity. The reasoning above survives the correction: adding a fourth
  participant to a precedence rule nobody has re-derived is exactly as unsafe as
  breaking an exclusive lock, and arguably less obvious.

**A sheet is a maintenance log because its HEADERS say so, never because of its
name.** `Jan 2026` and `OVERVIEW2026` both say "Terex".

## 4. What else the real data forced

- **Row 3 is an instructional EXAMPLE** — column A literally reads `example`, and
  the row describes a Powerscreen call that never happened. Absorbing it would
  manufacture a maintenance record. Skipped, and counted.
- **The log is a year/month scaffold.** Rows carrying only a year in column A or a
  month name in the date column are section headings. 132 of them on the 2026
  sheet. They are not events.
- **The date column cannot be trusted into a DATE.** Of 81 events: 64 real dates,
  6 free text (`"09/16 or 17"` — the operator genuinely did not know which day —
  plus `"Jan.14"`, `"Jan"`, and the typo `"1/14/202601"`), one **1900-01-14 Excel
  epoch artefact** whose real date is written inside the issue text, and 10 blank.
  A date is kept only when the cell held a real date in a plausible range;
  `event_date_raw` always keeps what was written. Guessing `"09/16 or 17"` invents
  a day the operator deliberately refused to pick, and letting the epoch artefact
  through sorts one event to the top of every view forever.
- **A blank cost is NOT RECORDED, never $0.** A repair nobody priced is not a free
  repair, and zeroing it understates maintenance spend.
- **`Estimated repair time/cost` is free text** (`"2 weeks"`), so it stays text.

## 5. The confirm step

`/admin/doc-ingest/terex` shows the staged batch: the totals, the sheets read,
the de-duplication, the undated count. Accept or discard, per batch, attributed.

The batch is a **version, not a row**. Asking someone to tick 80 maintenance
events individually guarantees they stop reading them; showing the totals and
taking one decision is the review that actually happens.

Enforced in the database: a `confirmed` row must name `confirmed_by` and
`confirmed_at`, a `discarded` row must name who discarded it. Money data whose
acceptance cannot answer _"who accepted this?"_ is not an audit trail.

Re-absorption refreshes only `staged` rows — it never un-accepts money somebody
already accepted, and never resurrects a batch somebody discarded.

## 6. Verification

12 extractor tests; full suite **4,122 passing**. Every guard **falsified before
being kept**:

| Break                                            | Went red |
| ------------------------------------------------ | -------- |
| de-duplication removed (the $77k → $154k defect) | ✅ 2     |
| the instructional `example` row absorbed         | ✅ 8     |
| any sheet treated as a maintenance log           | ✅ 2     |
| epoch / ambiguous dates accepted as real         | ✅ 1     |
| a blank cost becomes $0                          | ✅ 9     |
| year/month scaffold rows absorbed as events      | ✅ 8     |

The `ABSORBABLE_KINDS` tripwire fired for the **second** time today and was
updated to the new exact set rather than loosened — adding a kind without its
extractor and its typed table must keep breaking a test.

## 7. What this does NOT close

- **The commodity tracker is still unabsorbed**, and still needs a decision from
  Bill rather than code: it is a compliance checklist (`Audited | Initials |
Date | 2nd Audit` per commodity band), not a set of figures. Absorbing it would
  produce a queryable table of ticked boxes.
- **No comparison against Vision's own numbers.** Maintenance cost has no
  counterpart figure in Vision today. The natural one — cost per operating hour —
  lives in the monthly tabs this amendment deliberately does not absorb, and
  wiring it would need the single-writer question answered first.
- **The monthly operating tabs remain the interesting unanswered question.** They
  hold a genuinely independent record of daily processed units, which is exactly
  the kind of cross-check the reconciliation surface exists for — but as a
  _comparison_, never as a second writer.
