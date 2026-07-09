# ADR-0050 — Compliance-admin ledger

**Status:** Proposed — post-cutover build. **Not before 8/1.** This document captures the locked direction from the 2026-07-08 planning session; the D-items below are for a post-cutover D-review before any code is written. **No code is written for this ADR yet.**
**Date:** 2026-07-08
**Related:** ADR-0034 (Kelsey Q5 source), ADR-0045 (parallel task ledger pattern)
**Source:** `docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md` §2.2 (verbatim)

## Context

Kelsey's survey Q5 described DR3's compliance surface as a broad evidence ledger — COIs, bed-bug training/plans/signage, permits, scale inspections, fire inspections, vendor desk audits, closure plans (Woodland AND the closing CA site 2026), HazMat plan. Each item has an owner, renewal cadence, expiration, evidence, and expiration alerting.

Bill inherits permits/legal/COIs on 8/1 (Kelsey rolls off); site managers inherit floor-level items. Without a first-class Vision module, that inheritance lands as a folder of spreadsheets + calendar reminders.

## Proposed decisions (post-cutover D-review)

- Table: `compliance_items(id, kind, title, owner_user_id, site_id, cadence_pattern, expires_at, next_review_at, evidence_r2_key?, notes)`
- Kind enum: `coi`, `permit`, `bed_bug_program`, `inspection`, `vendor_audit`, `closure_plan`, `hazmat_plan`, `training`, `signage`, `other`
- Ownership: per-item, mapping to the compliance split from this session (Bill = permits/legal/COIs; site managers = floor-level for their site)
- Alerts: 90/30/7-day windows before expiration, routed via `notifyStaff()` to the specific owner
- Evidence storage: R2 under `compliance/{site}/{kind}/{itemId}/`; matches the ADR-0046 attachment pattern
- Handoff-friendly: an import CSV format lets Kelsey dump her existing tracker before 8/1

## D-items for post-cutover review

- D1: Kelsey's tracker format (import shape)
- D2: alerting cadence tuning per compliance kind
- D3: closure plan special-case (legal review dependencies)
- D4: whether Bethany's board digest surfaces upcoming compliance items

## Consequences

Deferred with the build. Recorded here so the post-cutover session starts from the locked direction rather than a blank page.
