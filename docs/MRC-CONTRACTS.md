# MRC contracts — consolidated reference

DR3 operates under two separate stewardship contracts, one per state. These contracts are the legal foundation for every compliance metric, deadline, and SLA in DR3-Vision.

This document is a working reference. The authoritative documents are the executed contracts themselves (in transcript: `DR3_Recycling_Service_Agreement_CA_2024_FINAL_09_03_2024__ggh_.docx` and `DR3_OR_Recycling_Services_Agreement_MRC_MARKUP_12_02_2024_kr__ggh_.docx`).

## At a glance

|  | California (Woodland) | Oregon (Eugene) |
|---|---|---|
| **Counterparty** | MRC California LLC | MRC Oregon LLC |
| **Statute** | SB 254 (2013), Used Mattress Recovery and Recycling Act | SB 1576 (2022) |
| **Regulator** | CalRecycle | Oregon DEQ |
| **Term** | 2025-01-01 to 2027-12-31 | 2025-01-01 to 2027-12-31 |
| **Per-unit rate** | $16 (2025) / $16.50 (2026) / $17 (2027) | $17 flat through 2027 |
| **Rate above term** | CPI adjustment | CPI adjustment |
| **Billing cadence** | Mid-month + end-of-month | End-of-month only |
| **Recycling rate target** | **75%** by weight | **70%** by weight |
| **Storage limit** | 3,500 inside + 5,000 outside | **6,000 total on-site** (off-site PROHIBITED) |
| **Processing deadline** | 45 days from delivery | 60 days from delivery |
| **Records retention** | 4 years | 5 years |
| **Customer service hours** | 8:30am–4:30pm M–F | 8:00am–4:00pm M–F |
| **Consumer Incentive Program (CIP)** | Yes — Woodland is a CIP location | No |
| **Collection Site Count fee** | N/A | $2.25/unit at Salem, Albany, Cottage Grove, Florence |

## Common SLAs (both contracts)

- **Dock-appointment SLA:** ≥90% of loads begin unload within **60 minutes** of scheduled appointment time (Article 11.3)
- **In/out reconciliation:** ≥97% match between unit count delivered and unit count processed
- **Inbound MyMRC entry:** within **3 business days** of receipt (Exhibit H §3)
- **Processed-units MyMRC entry:** within **1 business day** of processing (Exhibit H §3)
- **Withhold for breach:** **10% payment withhold** on metrics not meeting threshold

## California specifics

### CIP (Article 6)
- $3 per unit consumer incentive
- Maximum 5 units per vehicle per day
- Drop-off only at certified CIP locations (Woodland is one)
- Reimbursement claimed monthly via dedicated MyMRC report

### Storage (Article 6.5–6.6)
- **3,500 units indoor** at Woodland
- **5,000 units outdoor** at Woodland — *contracted allowance not exercised: DR3 does
  not use outdoor storage. Vision does not track outdoor units per the ADR-0037
  addendum (2026-07-22).*
- Exceeding either threshold is **termination grounds** — automatic notification automation required
- Daily inventory snapshots are required for compliance reporting

### Retention (Article 12)
- **4 years** for load records, photos, weight tickets, BOLs
- Audit log lives separately (indefinite per ADR-0007)

### Bedbug protocol (Exhibit C §6)
- Distinct rejection category from other contamination
- Photo and quarantine documentation required
- Special disposal channel with separate billing

## Oregon specifics

### Storage (Article 3.5)
- **6,000 units total on-site**, no inside/outside split
- **Off-site storage is PROHIBITED**
- Exceeding the threshold is **termination grounds**

### Retention (Article 12)
- **5 years** for load records, photos, weight tickets, BOLs

### Collection Site Count (separate billing)
- Four named locations: Salem-Keizer, Albany-Linn, Cottage Grove, Florence
- $2.25 per unit additional fee for hauls originating at these sites
- Separate Oregon Collection Site Count Invoice (V2.2 export — placeholder route in MVP)

### No CIP
- Oregon does not run an equivalent program
- The `load_source_type = 'cip_consumer'` enum value is not valid for `site_id = eugene`

## Compliance targets summary

These are the dashboard-tracked metrics in `docs/COMPLIANCE.md`:

1. **MyMRC submission timeliness** — ≥95% inbound within 3 business days
2. **Processed-units submission** — ≥95% within 1 business day
3. **Dock-appointment SLA** — ≥90% within 60 minutes
4. **Recycling rate** — CA ≥75%, OR ≥70% by weight
5. **In/out reconciliation** — ≥97% match
6. **Storage inventory** — within site limit (CA **indoor** 3,500; OR **total on-site** 6,000). Vision grades **indoor-only** — the CA 5,000 outdoor allowance is not tracked or graded (DR3 never stores units outside; outdoor was removed from Vision per the ADR-0037 addendum, 2026-07-22).
7. **Records retention status** — within window (CA 4yr / OR 5yr)

Failing any of these triggers contract penalties, the most severe being storage breach (termination grounds) and recycling rate below threshold (10% withhold).

## What "site separation" means contractually

Eugene loads are **only** governed by the OR contract. Woodland loads are **only** governed by the CA contract. No load belongs to both.

This is why:
- Recycling rate is calculated per-site (not blended across sites)
- Storage limits apply per-site (each has its own threshold)
- Retention is per-site (CA 4yr, OR 5yr)
- Billing is per-site (separate MyMRC accounts, separate invoices)
- ntfy alerts include the site code (`dr3-vision-system-woodland` vs `-eugene`)
- CSV exports are per-site by default; cross-site export is admin-only and requires explicit confirmation

A reporting tool that blends Eugene and Woodland into one number is **incorrect** for compliance purposes. Show them separately, label them, and only aggregate when an admin explicitly requests it.

## Pending events

- **April 1, 2026:** CA per-unit rate changed from $16 (2025) to $16.50 (2026). Already in effect.
- **January 1, 2027:** CA per-unit rate changes to $17. Database `site_billing_rates` table holds these forward; no code change required.
- **December 31, 2027:** both contracts expire; renewal negotiations expected mid-2027.
- **MRC API access:** email request sent 2026-05-04, no response yet. If granted, supersedes ADR-0009.

## References

- CA Contract: `DR3_Recycling_Service_Agreement_CA_2024_FINAL_09_03_2024__ggh_.docx` (in transcript)
- OR Contract: `DR3_OR_Recycling_Services_Agreement_MRC_MARKUP_12_02_2024_kr__ggh_.docx` (in transcript)
- Charter §1.5 (Contract context)
- ADR-0010 (CIP scope deferred to V2.2)
