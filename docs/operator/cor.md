# COR — Certificate of Recycling, Employment and Inventory (Exhibit 5)

**Who:** Woodland (California) managers + admins. **Where:**
`/dashboard/woodland/cor`. Oregon has no Exhibit 5 — the surface is hidden for
Eugene and the page 404s there.

**The principle (mission, verbatim):** *Vision pre-fills and renders; a human
always reviews and signs; Vision never auto-certifies.* Every printed number is
generated from Vision records you can drill into; the one human judgment (the
FT/PT split) is captured with its pre-fill on the record. The rendered PDF's
signature block is **blank** — Rick prints it, signs by hand, and submits.

## Monthly flow

1. **Generate** — pick the cover month and press *Generate / regenerate draft*.
   Vision pre-fills the three numbers:
   - **Inventory at month close** = the pool-aware running balance (the ONE
     inventory function, ADR-0037) as of the month's last day, cross-referenced
     to the nearest physical snapshot. Drill in via *Balance ledger + snapshot*.
   - **Headcount** = the month-end daily-close `employees`/`processors` totals,
     with the whole month's close series shown under *Daily-close series*.
   - **Signer** = Rick Albritton, *Transportation Manager* (from site config).

   Regenerating replaces the current draft (prior draft voided, version +1) and
   re-reads the latest data.

2. **Review** — check each number against its source rows. If the inventory
   ledger has moved since you generated (a *drift* banner appears), regenerate
   before finalizing. The capacity banner (indoor units vs the site limit, warn
   at 90%) is context only — it never blocks.

3. **Enter the FT/PT split** — the daily close captures *totals*, not a
   full-time / part-time breakdown. You know the roster: enter FT and PT and
   press *Save split*. The entry is audited and the daily-close pre-fill is
   retained, so the split is always traceable to what Vision pre-filled.

4. **Finalize** — press *Finalize* and confirm. Finalize requires both FT/PT
   entered, re-checks the inventory reconcile, and freezes the certificate.
   **Finalized certificates are immutable** — a correction is a new *superseding*
   version (both retained).

5. **Print → Rick signs → submit** — press *Download PDF (print & sign)*. The PDF
   renders from the stored certificate with an **empty** signature line. Rick
   prints it, signs and dates by hand, and submits per the current MRC process.

## Corrections

- **A finalized certificate is wrong** → open it and press *Supersede (new
  version)*. Vision creates a fresh draft at the next version pointing back at the
  finalized one. Re-review, re-enter the FT/PT split, finalize, print, sign.
- **Discard a draft** → *Void draft*. **Cancel a finalized one** → *Void*.

## The signer title is TBC

The seeded title, *Transportation Manager*, is what the June COR read but is
**flagged TBC with MRC** (see `docs/QUESTIONS.md` Q-5). When MRC confirms the
correct title it is a **one-row edit** to `cor_site_config` — never a code change,
never retyped per certificate. Until then every certificate prints the seeded
title.
