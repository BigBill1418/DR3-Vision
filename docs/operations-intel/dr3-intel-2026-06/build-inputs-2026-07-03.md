# DR3 Intel survey → build inputs (pulled 2026-07-03, 8/10 submitted)

**Canonical requirement input for the ADR-0036 mission build.** Pulled via SQL per
locked decision 2.2 #1 ahead of the Monday campaign close (the full formal export
lands at close; Mary Scott's GP-integration packet is still outstanding — Leisha
Wallace withdrawn by design). **Every ADR from 0039 on, and every P2+ phase, must
trace its requirements against this document.** Operator directive 2026-07-03:
"all of that survey data needs to influence what and how we build — informed
product, simple yet accurate."

## A. Findings already folded into in-flight work

| Finding | Source | Landed where |
|---|---|---|
| Processed units MUST split program/non-program; **MRC is billed program units only** (200 on floor = 150P+50NP, process 175 → report 150P+25NP, bill 150). Applies to BOTH states. | Rick Q11 | ADR-0037 D5 amended mid-build: `program_units_processed` + `non_program_units_processed` |
| Renovation whole units are ALWAYS non-program when inventory supports it; program units sold to renovation leave PROGRAM inventory and can NEVER be billed as processed | Rick Q11 | ADR-0037 D4 amended: renovator program/non-program split; D6 balance is pool-aware {program, nonProgram, total} |
| **CA fuel surcharge formula captured**: `(EIA West-Coast ULSD weekly rate ÷ 6.5 mpg) × miles driven`, index at eia.gov `pet_pri_gnd_dcus_r50_w` | Rick Q6 | ADR-0037 D1 seed params (computation wired in P2) — closes a Kelsey-July-capture item early |
| Re-TRAC ID = the MyMRC Haul/Materials number (Re-TRAC was MyMRC's predecessor) | Kelsey Q3 / Rick | ADR-0038 post-acceptance note: mirrors map retrac_id 1:1 |
| OR rate $17.00 locked through 2027; from 2028-01-01 CPI-indexed annually (verbatim contract quote) — CA already CPI-indexed post-2027 | Kelsey Q2, Rick Q10 | ADR-0037 D1 effective-dated rules accommodate; no action until 2028 |

## B. Direct spec input for ADR-0039 (3-way audit) — the heart of P1

- **The audit's reason for existing, in Rick's words (Q9):** "I find mistakes in
  unit count, processing counts, as well as Outbound Load counts all the time in
  MYMRC… without the ability to reconcile the data separately (not blindly trust
  the data being supplied by MYMRC) I will have a very hard time approving the data
  package." → The audit is also the **billing trust gate**: Rick must be able to
  independently verify Vision-vs-MyMRC before any P2 invoice goes out.
- **Timing expectations** (tolerance windows): inbound entered to MyMRC same-day at
  truck reconcile (Janette Q1); outbound entered to spreadsheet on ticket receipt
  but finalized to MyMRC at END OF DAY — Material # only exists then (Janette Q1).
  So intra-day "missing in MyMRC" is normal for outbound; the audit's lateness
  clock starts at EOD, not entry time.
- **Vendor-invoice reconciliation lags up to a month+** ("some vendor invoicing is
  slow, and sometimes I'm slow" — Kelsey Q8) — a discrepancy leg involving vendor
  invoices needs a long open-window, not a 24h alarm.
- **Most errors historically live in the BILLING spreadsheets** because data is
  re-entered multiple times (Kelsey Q8) — exactly the leg Vision generation (P2)
  eliminates; the audit should weight the MyMRC↔logs legs accordingly.
- **Discrepancy surface requirements (Morena Q5/Q8):** show provenance — where the
  number came from, who entered it, when, what changed; a notes field to document
  the cause ON the discrepancy; and **classify data-entry issues vs. real
  operational issues** (late load / hold not scheduled / entered under wrong date
  vs. wrong count). Root-cause context matters: "low production because no inbound
  material" must not read as team underperformance (Morena Q4).
- **Retro-audit reality check (Janette Q8):** the Woodland daily-log template has
  gone through ≥3 generations (no calculations → calculations added → EOD-inventory
  carryover added). Historical workbook ingestion (ADR-0039) must tolerate all
  three shapes.
- **Known live defect the audit should catch on day 1 (Janette Q11):** Friday
  ending inventory does not carry into Monday correctly in the current spreadsheet
  — the computed running balance (ADR-0037 D6) is the fix; the retro-audit should
  quantify how often this happened historically.
- Eugene counts are trusted ("dead on", spray-paint stack ledger EOD count —
  Patrick Q1/Q5); Woodland per Patrick "goes with whatever is in the cpu, no final
  EOD count" (Q3) — per-site confidence asymmetry the audit should surface, not
  assume away.

## C. Billing (P2) inputs — several open-register items now ANSWERED

- **CA mid-month cutoff (was open register):** "Processed Program units from the
  1st to the 15th regardless of day of the week" (Rick Q2).
- **Fuel surcharge formula** — see §A (was pending Kelsey capture; Rick supplied).
- **DR3 # semantics:** Woodland = manual increment from previous number (typo-prone
  — Rick Q8 "a typo in load number can delay payment"; Vision should assign);
  Eugene = scan date/time stamp, uniqueness is the only rule (Rick Q7, Janette Q2).
- **Material # is assigned BY MyMRC at outbound entry (EOD)** — Vision can never
  pre-fill it; the audit treats it as MyMRC-owned (Janette Q1/Q2).
- **Rick's billing flow today** (Q1): daily logs → several spreadsheets
  (transportation; inbound/outbound split by Program / Non-program-unpaid / CIP;
  Eugene adds collection-sites sheet) → summary page → Mary → invoices → MRC,
  different docs to different MRC groups. Vision P2 replaces the spreadsheet layer;
  Rick's approval gate + independent check (§B) is the acceptance bar.
- **Billing approval must survive Rick's typo concern**: load-number entry should be
  picker/scan, not typed, wherever Vision captures it.

## D. New scope items → open register / later phases (not in P1)

1. **Trailer/yard list in Vision** — "any team member should be able to check in
   and see what is being stored in the yard and how long" (Kelsey Q1). Weekly
   Stockton logs die with the 07-11 expiration, but the trailer list survives as a
   Vision feature request. → propose in P4/P5 window.
2. **Dispatch ↔ Outlook-calendar integration** (Morena Q1/Q3/Q8): MRC dispatch,
   holds, late/moved loads live in Outlook + email + texts today; Morena manually
   cross-checks. Big simplification lever, real scope — needs its own decision
   (open register; overlaps P5 task ledger + expected_loads).
3. **Equipment downtime & safety events as first-class records** (Bethany Q4, Juan
   Q2/Q7, Janette Q6): Terex has its own side spreadsheet; near-misses (high bale
   stacks) untracked. P4 Terex module should absorb downtime notes; safety events
   → open register.
4. **Processor-facing bonus standing view** (Patrick Q7): processors seeing their
   running bonus ("I'm at $250 on the 20th") — small, high-morale surface off
   existing bonus data. → candidate quick win, propose post-P1.
5. **Compliance-admin ledger** (Kelsey Q5): COI, bed-bug training/plan/signage,
   permits, scale inspections, fire inspections, vendor desk audits, closure plans,
   HazMat plan (Woodland AND the closing CA site for 2026). Mission said "not a
   Vision calendar build" for licenses — but Kelsey's list is broader compliance
   *evidence*; keep on open register with the licenses-owner decision.
6. **Contract-loss data contingency** (Kelsey Q7): "if our contract isn't renewed
   we no longer have access to the MyMRC data" — ADR-0038's mirrors + raw payloads
   already give Vision an independent copy; note it as a deliberate benefit.
7. **CalRecycle (P6) data spec advanced** (Kelsey Q6): needs inbound unit numbers +
   outbound commodity weights; 2026 filing covers Woodland AND the closing CA
   site's activity (even non-MRC); Kelsey has the tracking files to hand over.
8. **Stockton wind-down flexibility** (Morena Q7): Vision should represent what is
   active/moved/pending as Woodland absorbs the volume — affects site lifecycle
   assumptions, watch during P2+ (internal provenance only; hard rule #1 keeps the
   name out of user-facing surfaces).

## E. Dashboards & reporting cadence (P3/P5 shaping)

- **Morena's morning 5** (Q4): today's MRC loads/holds incl. late/unconfirmed ·
  inventory + yard capacity · yesterday processed + saved/rebuilder + today's goal
  · staffing coverage · exceptions needing action (missing entries, mismatches,
  dispatch≠calendar, equipment down, late trailers) — each with the WHY visible.
- **Bethany's board pack** (Q5/Q7): units processed MTD vs same month last year ·
  units inbound · expenses MTD · injuries/safety · P&L when financials land.
  **Hard cadence: processed for previous month + MTD due every second Wednesday
  AND the Monday preceding it** — a real reporting deadline Vision should generate
  for (P5 digest candidate).
- **Shannon** (Q2): condensed Eugene report — inbound, outbound, avg material
  weight on floor, recycling rate; wants "everything" for CA when oversight shifts.
- **Kelsey's meta-list** (Q10): data quality via simpler entry · communication ·
  centralized transparent info · documented processes · redundancy ·
  invoicing/accounting efficiency — the mission's north star, verbatim from the SME.

## F. Design principles the corpus demands (operator-affirmed)

1. **Enter once, use everywhere** — the #1 complaint across Morena/Kelsey/Rick:
   the same fact typed into email + Outlook + Excel + MyMRC + Vision.
2. **Every number carries provenance** (who/when/what-changed) and a place for a
   note — Morena asked twice; audit_log already exists, surface it.
3. **Explain, don't just flag** — dashboards and discrepancies separate
   data-entry issues from operational causes.
4. **Built for the people entering data first, leadership reports second**
   (Morena Q8, verbatim) — "simple enough for the team to use correctly, detailed
   enough so leadership gets accurate information."
