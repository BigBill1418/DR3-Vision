# Invoices — operator guide (ADR-0041)

Vision generates the monthly MRC invoices that used to be assembled by hand from
several spreadsheets. Every number on an invoice is a query result with a
provenance trail — you can click any line down to the rows that produced it. The
Summary is **generated, never hand-entered**.

Surface: **Dashboard → your site → Invoices** (`/dashboard/<site>/invoices`).
Site-scoped: you only ever see and act on your own site's invoices.

## The six invoices per month

| Kind | Site | What it bills |
|---|---|---|
| CA Processing — Mid-Month | Woodland (CA) | Processing for the 1st–15th (B20) |
| CA Processing — EOM | Woodland (CA) | Full-month processing + incentives + event misc, **less** the mid-month already invoiced (B22 = B15 − B20) |
| CA Transportation — EOM | Woodland (CA) | Freight + event freight + fuel surcharge + container rentals (B16) |
| OR Processing — EOM | Eugene (OR) | Full-month processing (+ incentives / event misc if any). Oregon is end-of-month only. |
| OR Transportation — EOM | Eugene (OR) | Freight + container rentals. **No fuel surcharge** (Oregon never carries one.) |
| OR Collection-Site Count | Eugene (OR) | $2.25 × satellite site counts — **entered by hand** (no data feed yet). |

## Generating a draft

1. Pick the **invoice kind** and the **billing month**, then **Generate draft**.
2. A draft is a **preview** — it is not billable until approved. Regenerating
   replaces the current draft with a new version (the old draft is voided).
3. If generation fails, the message tells you why — usually a **missing rate**
   (seed the effective-dated rule), a **freight that can't be priced** (a
   transport-charged load with no source or mileage / an unseeded OR tier), or a
   **missing weekly fuel price**. Money paths fail loud on purpose — Vision never
   bills $0 by accident.

## Reviewing before you approve

Open a draft to see every line. For each line, **Source** expands the exact
provenance — the query window, the row ids/counts, and the rate/tier/override row
that priced it. Freight lines link straight to the loads they came from.

- The **B22 offset** line on the CA EOM invoice is the honest "less mid-month
  already invoiced" subtraction — it shows as a negative (in parentheses). This is
  the number that used to appear as the mysterious "$118,239 Trade Discount".
- If this is a re-generated version, a **Δ vs. prior version** column shows what
  changed line-by-line.
- The **Window trust gate** panel shows whether the 3-way audit (ADR-0039) is
  clean for this window. If it is **blocked**, resolve the listed findings first.

## Approving (the freeze)

Only a **manager of this site** or an **admin** can approve — the rate-management
permission alone is **not** enough. Approving:

- re-checks that the total still reconciles to the lines,
- re-runs the trust gate (a blocked gate refuses approval and lists the finding
  codes),
- freezes the invoice: **an approved invoice is immutable.**

If the gate is blocked but the invoice must go out anyway, a **super-admin** can
override by entering a justification — this is audited and recorded on the invoice.

## Correcting an approved invoice

You never edit an approved invoice. Use **Supersede** to create a new draft
version that supersedes it (both are retained — the audit trail is the point).
Review and approve the new version as usual. **Void** cancels an invoice (a draft
you're discarding, or an approved one that must be pulled).

## Exporting

From an approved invoice, **Download xlsx** produces the Summary workbook.
Vision also emits a neutral `invoice_export` JSON (the Great Plains boundary) —
the accounting hand-off consumes that; the GP adapter itself is pending.

## Two honest manual islands (flagged, by design)

- **OR collection-site counts** have no Vision feed yet — that invoice is built
  from lines you enter, tagged as manual.
- **Event costs (B8 / event freight)** come from the collection-events capture,
  which is being wired in. Until then, the event lines show **$0 with a
  "pending: events-integration" marker** — never silently missing, so you always
  know the number is not yet complete.
