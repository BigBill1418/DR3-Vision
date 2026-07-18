# Woodland daily-log workbook — parser schema

Reference for the ADR-0048/0049 §8.2 semantic parser
(`src/lib/audit/workbook/section-extractors.ts`) and the ADR-0037-amendment
inventory close (`src/lib/inventory/inventory-close.ts`). Cell references confirmed
against the CORRECTED June 2026 workbook (SHA
`1eeeccbde0db7824aaf859b4352c7ac5e28ccba9efa319adb0976e635a966295`), rollup
2026-07-17 §2.2.

## Sheets and how they are used

| Sheet(s)                                                                           | Semantic type               | Role                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DAY0`..`DAY31`                                                                    | `day`                       | Per-day per-shipment grid: INBOUND grid (top) + OUTBOUNDS commodity blocks + the DAY summary box (Starting/Ending inventory, INBOUND, Processed, Saved). **Authoritative for the carried-forward Ending-inventory close.** |
| `… Processed`                                                                      | `processed`                 | The workbook's OWN inventory ledger: per-day program/non-program inbound + stripped + sold + landfilled, opening balances, and the SUM row. **Authoritative for the billing close.**                                       |
| `… inb trans charges`, `… inb no trans charge`, `nonprogram`, `… incentive_unpaid` | category                    | The SAME inbound rows re-categorized for billing — staged as **evidence only**, never promoted (would double-count the DAY grid).                                                                                          |
| `commodities`, `renovation`, `all`                                                 | rollup                      | The DAY grid rolled up — **evidence only**.                                                                                                                                                                                |
| `Summary!`, `Trans Summary!`                                                       | `summary` / `trans_summary` | **STALE — Kelsey does not maintain these (§A.6). Advisory parity only; NEVER used for billing aggregation.**                                                                                                               |
| `variables`, `fuel`, `container_rentals`, `list`, `events`                         | reference                   | Rate/config reference — evidence only for the audit parser.                                                                                                                                                                |

## Processed-sheet columns → DAY-sheet source cells (§2.2)

Each Processed column is `INDIRECT`-sourced from the DAY sheets. `Processed` per-day
rows are keyed by a `Day N` label in column B; the month totals are the SUM row
(June = row 40).

| Col     | Meaning                                                                              | DAY-sheet source cell      | June SUM (row 40) |
| ------- | ------------------------------------------------------------------------------------ | -------------------------- | ----------------- |
| C       | Daily total inbound (`= F + G`)                                                      | `DAY!I38`                  | 19,680            |
| D       | Program stripped                                                                     | `DAY!I39`                  | 17,126            |
| E       | Non-program stripped                                                                 | DAY equivalent (0 in June) | 0                 |
| F       | Program inbound (`= I38 − G`)                                                        | `DAY!I38 − G`              | 19,451            |
| G       | Non-program inbound                                                                  | `DAY!L39`                  | 229               |
| H       | Sold units                                                                           | `DAY!I40`                  | 0                 |
| I       | Landfilled                                                                           | `DAY!I41`                  | 0                 |
| J       | Ticket (`M-#####`)                                                                   | `DAY!K39`                  | —                 |
| opening | Program open `Processed!D5` = `DAY1!L2` = 1,423; non-program open `Processed!F5` = 0 |                            |                   |

Reconciliation: `F40 + G40 = 19,451 + 229 = 19,680 = C40`.

## The inventory close — CORRECT arithmetic (§2.3)

Vision computes the close in code (`computeInventoryClose`), **never** from the
workbook's `D45`/`D48` literals:

```
program_close     = program_open + program_inbound − program_stripped            = 1423 + 19451 − 17126 = 3748
non_program_close = non_program_open + non_program_inbound − non_program_stripped − saved_units = 0 + 229 − 0 − 0 = 229
total_close       = program_close + non_program_close − sold − landfilled        = 3748 + 229 − 0 − 0 = 3977
```

June close = **3,977 (3,748 program + 229 non-program)**, cross-checked against the
DAY31 Ending-inventory cell (also 3,977).

`saved_units` (DAY `Saved` box) subtracts from the non-program pool (§A.2). Sequential
depletion (`sequentialDepletion`, §1.1) splits a day's stripped total program-first;
June strips only program (E40 = 0), so it is a no-op for June.

## Known workbook-side bugs (code uses correct arithmetic, ignores the literals)

- **`Processed!D45`** (`= F5 + E40 + G40 − H40 − I40`) **ADDS** non-program stripped
  (`E40`) instead of subtracting it. Harmless for June only because `E40 = 0`. Any month
  where the program pool runs dry and non-program is stripped would overstate the
  non-program close. Vision subtracts (see §2.3).
- **`Processed!D48`** (`= D42 + D45 − H40 − I40`) **double-subtracts** sold/landfilled
  (already netted in D45). Harmless only because both are 0 for June.
- **`Processed!F9`** (Day-1 program inbound) hardcodes `'DAY1'!I38` instead of using the
  `INDIRECT("'DAY" & ROW()-8 …)` pattern every other day uses. Harmless because Day-1 →
  DAY1 either way, but a template row-shift would break it.

## The 85-unit DAY-grid over-sum (why the close reads the ledger, not the grid)

Re-summing the raw DAY per-shipment INBOUND grid gives **19,765** inbound units, but the
authoritative Processed ledger is **19,680**. The 85-unit gap is isolated entirely to
**DAY23**: a "Recology Healdsburg" row (85 units, marked `NP`) is a program-looking
`inbound units` grid row that the workbook's own `F = I38 − L39` accounting nets into the
non-program column. The workbook's per-day accounting is internally inconsistent (DAY29/30
include their non-program units in `I38`; DAY23 does not), so the grid can NOT be re-summed
to the billing totals. The **Processed ledger is billing-truth** and drives the close;
per-shipment grid rows are staged as promotion/evidence detail only. This is surfaced at
parse time in the `[inbound-reconciliation]` flag.
