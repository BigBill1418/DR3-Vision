# ADR-0067 Amendment 8 — detect the header row; make the confirm queue announce itself

**Status:** accepted, implemented (2026-07-31)
**Closes:** absorption-audit Fix 1 (badge) and Fix 2 (header detection), in full.
**Does NOT close:** Fix 3 (absorption of a new document kind) — and the reason is a
finding, not a shortfall. See §4.

## 1. Context

The 2026-07-30 absorption audit measured three defects. Two are closed here.

**Fix 1 was already half-shipped.** The `/admin` tile already points at
`/admin/doc-ingest` (the sources + confirm queue) and that page already links
onward to `/anomalies` and `/health` — verified on current `main`, contrary to the
handoff's premise. What was genuinely missing is the **count badge**. A tile that
looks identical whether or not three documents are waiting is how three documents
came to wait since 2026-07-29 09:14 PDT with nothing anywhere in the app saying
so. The badge counts exactly what the confirm queue shows — a FILE with an
attempted classification and no registered kind — because a number on a tile that
the queue then does not show is worse than no number.

**Fix 2 was real.** `parse.ts` took the first non-empty row as the header, with a
comment claiming it was "correct for every workbook this pipeline has seen". The
audit falsified that 3 of 3. It is not a cosmetic mis-label: the structure half of
the classifier matches on column names (so classification was filename-only), and
the D7 aggregate-variance guardrail's monitored-column regex could never match a
title string — so a "clean guardrail verdict" meant _there was nothing to
compare_, not _the change was safe_.

## 2. Decision — detect, do not assume

The fix is emphatically **not** "use row 2". Assuming a different fixed row
reproduces the same class of defect one row lower.

`detectHeaderRow` scans the first 12 rows and takes the first row that is both
**wide** (≥ 60% of the widest row seen, minimum 2 cells) and **label-like** (≥ 60%
of its populated cells are non-numeric, non-date, ≤ 60 characters). A merged title
row is narrow against the sheet; a data row is wide but numeric; a header row is
both wide and textual.

Three things are recorded that were not before:

- `headerRowIndex` — which row was chosen (1-based).
- `headerConfidence` — `strong` (cleared both bars), `weak` (nothing did; the
  widest row was taken), or `none` (no non-empty row).
- `titleRows` — the rows skipped above the header, kept as classifier signal and
  joined into `textSample`.

`weak` exists because the failure mode being fixed is a _confident wrong answer_.
A sheet with no real header should say so.

The same detection runs on the CSV path. An exported CSV carries the same merged
title line as the sheet it came from.

## 3. Verified against the real documents, not the audit's summary of them

The three live workbooks were pulled out of R2 and parsed with the new detector.
**All three resolve `strong`, and every sheet now surfaces real column names:**

| Document                   | Header row | Detected columns (excerpt)                                                                                                       |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Woodland trailer list      | **2**      | `Date of Entry to Yard`, `Trailer #`, `Material`, **`Weight (lbs)`**, `Driver`, `Days in Yard (auto calc)`, `Exit Date`, `Notes` |
| TEREX maintenance log      | **2**      | `Date *`, `Issue *`, `Measures taken *`, **`Estimated cost`**, **`Actual Repair Cost`**, **`Amount Credited`**                   |
| TEREX "Maintenance Prices" | **3**      | `Price`, `Invoice Date`, `Reference`, `labor hours`, `machine hours`, `hours since last oil change`                              |
| Woodland commodity tracker | **4**      | `Audited`, `Initials`, `Date`, `2nd Audit`, `Initials`, `Date`, … (repeating per commodity band)                                 |

The bolded columns (`Weight (lbs)`, `Estimated cost`, `Actual Repair Cost`,
`Amount Credited`) match the D7 monitored-column regex. **The aggregate-variance
guardrail has real signal for the first time.**

Note the spread of header rows — **2, 2, 3 and 4**. Any fixed-row assumption is
wrong on at least one of the four sheets.

## 4. The finding that changes Fix 3

The handoff recommends the commodity-audit tracker as the first absorption type,
on the grounds that it "cross-references commodity data against vendor invoices"
and therefore carries the highest reconciliation value.

**Reading the actual file shows that is not what it contains.** The sheet is
banded: a title row, then a commodity band (`METAL | WOOD | TOPPERS | FOAM |
TRASH | XTRACTION`), then a vendor band (`METAL - GreenZone`, `WOOD - Biomass`,
`TOPPERS - All Vendors`, …), and on row 4 a repeating group of
**`Audited | Initials | Date | 2nd Audit | Initials | Date`** per commodity.

There is **no weight column, no amount column, no invoice number, and no
variance**. It is an audit **checklist** — who checked which commodity band, with
their initials and the date — not the commodity figures themselves. Absorbing it
would yield "who ticked which box", not a comparison against Vision's numbers.
The reconciliation value the handoff attributes to it is not in this file.

**The better first absorption type is the trailer list**: a clean flat table with
`Material`, `Weight (lbs)`, `Date of Entry to Yard` and `Exit Date` — real
operational data with a natural Vision comparison (trailers in the yard, and
material weight against outbound records). TEREX is the strong second, and it is
money-touching (`Actual Repair Cost`, `Amount Credited`), so it would land under
the preview-then-confirm rule.

Building the wrong extractor tonight and calling Fix 3 done would have been worse
than not building it: it would have produced a queryable table of ticked boxes and
the appearance of absorption. Fix 3 is therefore **specified, not shipped**, and
specified against evidence rather than against the assumption in the handoff.

## 5. What must not regress, and did not

- **Amendment 4** (classify AFTER ingest) — untouched; no ordering changed.
- **Amendment 6** (a delta may supply but never remove a content marker) —
  untouched; this amendment changes only how `parse_summary` is _derived_, never
  how versions are compared or applied.
- `absorb.ts` carried a comment asserting that `parse.ts` "takes the first
  non-empty row … wrong on 3 of 3 live workbooks". That is now false, and a false
  assertion in a comment is the same defect as a false assertion in the UI
  (`messages.ts`, 2026-07-29). It has been corrected in place: the reason to stay
  on the layout-aware parser is that `parse_summary` is a _shape_ projection
  retaining no cell values — which is true regardless of how good the headers are.

## 6. Verification

11 tests. Every guard **falsified before being kept**:

| Break                                        | Went red |
| -------------------------------------------- | -------- |
| revert to first-non-empty-row                | ✅ 3     |
| always skip exactly one row ("assume row 2") | ✅ 1     |
| accept a wide row of numbers as the header   | ✅ 3     |
| unbounded scan window                        | ✅ 1     |
| invent a header row for an empty sheet       | ✅ 1     |

The "assume row 2" break initially **passed**, which was a defect in the test: on
a header-is-row-1 sheet the variant still landed on row 1 _via the weak fallback_,
and the test asserted only the index. It now asserts `confidence === 'strong'`,
which is what distinguishes "found it" from "gave up and took the widest row" —
and the break goes red.

The commodity-tracker fixture was replaced with the **real** four-row banded
layout after reading the file; the original fixture encoded the handoff's
assumed flat `Month | Commodity | Vendor | Invoice # | Weight | Amount` shape,
which does not exist.
