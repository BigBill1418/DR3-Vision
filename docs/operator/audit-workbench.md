# Audit Workbench & 3-way audit (operator guide)

ADR-0039. The audit reconciles **three independent copies of the truth** for a
site and window:

1. **Vision operational data** — what staff entered (loads, processed units,
   outbound, inventory).
2. **MyMRC mirrors** — what MRC's system believes (read-only copies).
3. **Billing** — P2 invoices once they exist; historical monthly **workbooks**
   stand in until then.

No leg feeds another, so a discrepancy in any one shows up as a **finding**.
This is the module that lets Rick independently verify Vision-vs-MyMRC before a
billing package goes out — and it runs over **any historical window**, including
the 8/1 coverage gap and prior months' workbooks.

Findings are **in-app signals only** — they never push to your phone (hard rule
#5). The ONLY push is a `dr3-vision-system` alert if the nightly sweep itself
fails.

---

## Where it lives

- **Review surface:** `/dashboard/<site>/audit` (manager portal, site-scoped —
  you see only sites you're assigned to; admins and all-sites managers see all).
- **Workbook import (admin only):** `/admin/audit/workbook`.

## The findings queue

Open `/dashboard/<site>/audit`. The **Findings** tab shows the queue, filtered by
status (default: **open**), and you can also filter by check and severity.

Each finding row shows the **check** (C1–C7 or the workbook Summary-recompute),
the **kind** (missing counterpart / value mismatch / date mismatch / unresolved
site / dropped row), a **severity** badge, and the **window** it covers. Click a
row to expand:

- **Expected vs Actual** — the two legs' values, side by side.
- **Provenance / detail** — where the number came from (who/when is in the audit
  log; workbook findings carry the exact tab/row/col).
- **Classify & act** — pick a **cause** (data entry / operational / external
  MyMRC / template defect / unknown — this separates *data-entry mistakes* from
  *real operational issues*), add an optional **note**, then:
  - **Acknowledge** — you've seen it, still working it.
  - **Resolve** — fixed at the source (requires a cause).
  - **Not an issue** — expected/benign (requires a cause).
  - **Reopen** — re-activate a closed finding.

**Findings never change the underlying data.** Fix the source record in its own
screen; the next sweep will auto-resolve the finding once the legs agree.

### What the checks mean

| Check | Reconciles |
|-------|-----------|
| C1 | Inbound units: verified loads ↔ MyMRC hauls (by Re-TRAC/haul id, units, date) |
| C2 | Processed units (program + non-program) ↔ MyMRC processed |
| C3 | Outbound + landfilled ↔ MyMRC outbound (by ticket/Material #, weight, date). Tolerates same-day gaps until **EOD+1** — outbound finalizes to MyMRC at end of day |
| C4 | Billing basis: program units processed in the window ↔ billed program units |
| C5 | Program/non-program conservation (can't process more program units than are available) |
| C6 | Inventory continuity: `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`; catches the Friday-doesn't-carry-to-Monday break |
| C7 | Deadline compliance: MyMRC entry lateness vs the 3-day inbound / 1-day processed / 3-day-from-EOD outbound clocks |

Tolerances (e.g. the C3 weight jitter, the C4 45-day vendor window) are **config,
not code** — they live in `audit_check_config` and can be tuned per site.

## The Workbench tab

Transcribes the shortcuts Kelsey hand-built into the daily log:

- **Inbound by source type** (standard hauls / drop-offs / incentive / illegal /
  event), with program vs non-program.
- **Outbound by commodity × sub-category** (renovation / baled / shredded), with
  auto weight derivation.
- **Inventory day-ledger** — the rolling balance with reconciliation deltas.

> **Current status:** the Workbench frames show an **"integration pending"** empty
> state. They activate automatically once the ADR-0037 loads/inventory tables
> land — until then they intentionally show no data rather than fabricating it.
> Each frame names its drill-down target for the wiring.

## Retro-audit: importing a historical workbook (admin)

Go to `/admin/audit/workbook`:

1. Pick the **site**, an optional **period label** (e.g. "June 2026"), and the
   **window** (start / end — end is exclusive).
2. Choose the monthly workbook (`.xlsx` / `.xlsm`) and **Import & audit**.

The file is parsed **server-side** into staging rows (never into operational
tables); the original is kept in R2 for evidence. Immediately, two checks run and
open findings on the site's audit queue:

- **Summary recompute** — recomputes every Summary figure from the workbook's own
  detail rows and flags any rows the template's SUM range **dropped** (the class
  where money silently fell out of the workbook, e.g. clipped fuel rows).
- **Site-name resolution** — verbatim workbook site names are resolved through
  the alias table; anything it can't resolve becomes an **`unresolved_site`**
  finding rather than a silently dropped row.

The parser tolerates the ≥3 template generations (no calculations → calculations
added → EOD-inventory carryover). The **Recent imports** table shows each import's
detected template generation, staged row count, and status.

## Nightly sweep

A daemon fires at **02:30 America/Los_Angeles** and audits a trailing 14-day
window per site. It writes an `audit_runs` ledger row every time. A healthy run is
silent; only a **failed** run pages `dr3-vision-system` (fingerprinted per site).
You can also run any window on demand from the review surface.

## Billing trust gate (for P2)

A window with open findings **at or above a configured severity** blocks P2
invoice generation for that window. A super-admin can override with a justification
(audited). Rick's approval = closing out the findings for the billing window
before invoices go out.
