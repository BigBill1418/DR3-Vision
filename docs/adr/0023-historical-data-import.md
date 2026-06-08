# ADR-0023: Historical Bonus Data Import

**Status:** Accepted
**Date:** 2026-06-08
**Decider:** Bill Barnard (Director of Operations, SVdP / DR3)
**Sprint:** Sprint 3 addendum
**Context:** Sprint 2 addendum cutover (2026-06-06) shipped the bi-weekly pay-period schema, signature chains, period-close cron, and Eugene enablement. Production goes live Tue 2026-06-09 on Period 13 of 2026 with empty bonus history. ADR-0023 imports the historical bonus spreadsheet (Jan 2025 → June 2026) into Vision as the canonical source of truth.

## Context

DR3 has tracked daily processor bonus on a single Excel workbook (`Bonus_Spread_Sheet_2026.xlsx`, SHA-256 `e172dd106d04e2244bb7b55c00be6fcf17caebada1daea0de915c6489d86805f`) since January 2025. That spreadsheet has 56 sheets covering three sites (Woodland, Stockton, Eugene) across two years, with three distinct layout formats and 17 months of accrued data ($113,776.00 / 5,158 daily entries / 94 unique processors after dedup).

Vision is now the system of record for bonus. Daily entry resumes Tue Jun 9 on Period 13 of 2026; without historical context, the reporting and analytics surfaces are blind to 17 months of accrued history. ADR-0023 imports the spreadsheet as a one-shot seed delivery so Janette and Rick walk in tomorrow morning with full historical visibility.

## Decision summary

The historical spreadsheet is parsed in design conversation (no upload UI), produces seven seed CSVs that ship with Sprint 3, and lands at `prisma migrate deploy` + `prisma db seed` time. Schema changes ship as a migration; data ships as seeds. The pivot from a runtime "Bulk Upload" feature to seed-time delivery was the right scope reduction once the design captured every needed decision (Q1–Q22).

## Decision detail (Q1–Q22)

The design dialogue locked 22 decisions. The mooted items (Q5, Q7, Q9, Q12) follow from the Q19 pivot to in-conversation processing.

### Q1 — Formula reconciliation: dual-total storage
Both `total_payout_cents` (corrected formula, threshold_high=74 Woodland) and `legacy_total_payout_cents` (as-paid spreadsheet, threshold_high=75 Woodland) are stored on every `historical_imported` period. The `imported_with_legacy_formula` boolean signals which total drives PDF and payroll display. Default for historical periods: legacy.

### Q2 — Identity resolution: pre-confirmed clusters
Twelve canonical employees with pre-confirmed aliases land at seed time (`bonus_employee_aliases_historical.csv`, 128 rows total). The remaining ~80 employees use deterministic name normalization (role-suffix strip, quoted-nickname strip, whitespace collapse). All Stockton-origin employees fold to Woodland canonical site (see Q11).

### Q3 — Pay periods 2025: bi-weekly extended back
The 2025 bi-weekly cadence is anchored at Period 1 of 2025 = Tue Dec 24, 2024 → Mon Jan 6, 2025, pay Fri Jan 10, 2025. 26 periods × 2 sites = 52 new pay-period rows. Total `bonus_pay_periods` count after seed: 104.

### Q4 — State machine: new terminal-ish state `historical_imported`
Periods loaded from the spreadsheet land in `historical_imported`. Amendable via existing admin workflow (`historical_imported → amended → pending_signatures → …`). PDFs generate for historical periods with import-specific attestation language.

### Q6 — Anomaly bundle
- `mattress_count` schema changes `Int → Decimal(5,1)` to preserve Eugene's historical half-shift values (23.5, 30.5).
- Empty/orphan rows skip silently.
- `-TERM` suffix strips + sets `is_active=false`.
- Missing Total cells recompute using the legacy formula (`total_source='recomputed_from_count'` flag in provenance).
- Outliers (>150 mattresses/day) log to anomaly report but import.

### Q8 — Two new state transitions
- `draft → historical_imported` (admin-only): 2025 periods are seeded as `draft`, then bulk-transitioned.
- `skipped → historical_imported` (admin-only): for a pre-cutover-skipped period that turns out to have historical data.

Both added to `ADMIN_ONLY_TRANSITIONS`. Single out-edge from `historical_imported` is `amended` (admin amendment workflow).

### Q10 — Eugene roster auto-creation
Importer auto-creates `BonusEmployee` rows for processors found in the spreadsheet. Patrick Dills, Stanley Crux, Mike Fetter, Orrin Fitzgerald, etc. land as Eugene `BonusEmployee` rows at seed time. Patrick Dills is also linked to his `User` row (the only employee↔user link the import creates).

### Q11 — No Stockton site row; provenance preserves origin
Stockton remains absent from `sites` table. `original_site_code='stockton'` is preserved in `import_provenance` JSONB on every Stockton-origin daily entry (1,869 entries / $41,399.50). All Stockton employees fold to Woodland canonical (Stockton/Woodland share the California MRC contract; staff travel between sites).

### Q13 — Eager PDF generation
All ~104 historical-period PDFs render and upload to R2 at seed/deploy time. The PDF defaults to as-paid (legacy) totals per Q1.

### Q14 — Sprint 3 scope bundle
Sprint 3 = historical import + T-122 (M365 Mail.Send setup) + T-123 (GlitchTip DSN). One addendum, one deploy.

### Q15 — Build today (Mon Jun 8)
Sprint 3 ships before Tue Jun 9 morning so Janette and Rick see full history on day one of production entry.

### Q16 — Auto-sum duplicate (employee, date) pairs
After Stockton-fold and identity merge, duplicate `(employee, date)` rows auto-sum with both source rows preserved in audit. `merge_strategy='auto_sum'` flag. Four such events in the v3 parse.

### Q17 — Audit log retention: max forensic granularity
Every imported daily entry generates an audit row with the full provenance JSON (`source_sheet_name`, `source_row_index`, `source_count_col`, `source_total_col`, `raw_count`, `raw_total`, `total_source`, `formula_version`, `original_site_code`, `merge_strategy`, `merge_source_count`). ~5,158 audit rows from this import. Estimated 75–100 MB audit-log growth.

### Q18 — UI accepts decimals going forward
Production daily-entry UI accepts up to one decimal place at both sites. Validation: `\d{1,4}(\.\d)?`. Schema change supports this (`Decimal(5,1)`).

### Q19 — Source `.xlsx` archived
The source spreadsheet is archived at `prisma/seed/historical/source-archive/Bonus_Spread_Sheet_2026.xlsx` and tracked in `bonus_imports.source_archive_path`. R2 promotion is a follow-up ticket (out of scope for Sprint 3).

### Q20 — Bulk Upload tile removed
The `bulk-upload` tile is removed from `DASHBOARD_TILES` entirely. Historical import is a one-shot operation, not a feature.

### Q21 — Hybrid delivery: schema migration + seed CSVs
Schema changes (new enum value, new transitions, decimal column, provenance fields, new tables) ship as `prisma/migrations/20260608_historical_data_import/migration.sql`. Data (~5,158 daily entries, 94 employees, 128 aliases, 76 pay-period state rows, 1 import-session row) ships as CSVs in `prisma/seed/historical/`. Re-deploy is a no-op (SHA-256 idempotency check).

### Q22 — No pre-flight reconciliation report
Locked decisions Q1–Q21 suffice. Reconciliation report ships as a `reconciliation.json` artifact alongside the CSVs for forensic reference but is not a deploy gate.

### Mooted by Q19 pivot
- ~~Q5~~ permanent admin feature: no UI built
- ~~Q7~~ Bill-only scope: no tile
- ~~Q9~~ `'super-admin'` TileScope: no tile
- ~~Q12~~ wizard backout semantics: no wizard

## Critical findings during implementation

### Production calculator formula is correct (no fix needed)
Initial analysis suggested a possible bug in `src/lib/bonus/calculator.ts` (tiered-substitution vs additive). Reading the source confirmed the calculator uses additive semantics correctly:

```typescript
const lowTier = Math.max(u - rule.threshold_low, 0) * ratePerUnitCents(rule.rate_low);
const highTier = Math.max(u - rule.threshold_high, 0) * ratePerUnitCents(rule.rate_high);
return lowTier + highTier;
```

This matches the spreadsheet's implicit formula. Worked examples:
- Woodland count=77, threshold_high=75: `(27 × $0.50) + (2 × $0.25) = $14.00` ✓
- Eugene count=102, threshold_high=100: `(52 × $1.00) + (2 × $0.25) = $52.50` ✓
- Eugene count=120, threshold_high=100: `(70 × $1.00) + (20 × $0.25) = $75.00` ✓

A previous historical doc walkthrough wrote `(50 × 1.00) + (20 × 0.25) = $75` for count=120 — the parenthesized arithmetic was off (gives $55, not $75), but the result was correct. The calculator code is the source of truth.

### Parser robustness: dynamic layout was load-bearing
A v1 fixed-stride parser silently dropped ~17% of Eugene entries because the spreadsheet's Eugene sheets switch between 3-col-per-day and 4-col-per-day patterns mid-sheet. The v3 parser uses dynamic date-column detection (`map_day_columns()` in `parse-historical-v3.py`): scan row 0 for date headers, infer the per-day total column as the last "Total" header before the next date anchor. Result: 5,158 entries / $113,776.00, vs v1's 4,883 / $96,511.25.

### Eugene 2026 sheets use Format A (4-col with "High Yield Bonus")
The bare-month-name Eugene 2026 sheets (`Jan 2026`, `Feb 2026`, etc., 126–127 cols each) use the Woodland-style 4-col-per-day format with a column labeled "High Yield Bonus" (semantically equivalent to Woodland's "High Volume Bonus"). The dynamic detector handles this transparently — site classification still produces `eugene` (no "woodland" or "stockton" in the sheet name), and the additive formula applies correctly because `processor_bonus_rules` for Eugene already has `threshold_high=100, rate_high=$0.25`.

## Consequences

### Positive
- 17 months of historical bonus visible in Vision from Day 1.
- Single source of truth: no parallel spreadsheet ongoing.
- Forensic provenance for every imported row (audit + JSONB).
- Stockton-fold preserved (cross-facility MRC contract accurately represented).
- Patrick Dills enters Vision as both `User` and `BonusEmployee` correctly.

### Negative
- ~75–100 MB audit-log growth from this single import.
- Re-deploy idempotency relies on `bonus_imports.source_sha256` — if the spreadsheet is updated and re-loaded, it gets a new import session ID (intentional, not a regression).
- The historical Woodland totals use the legacy threshold_high=75 formula; reports comparing 2025 to 2026 must account for the threshold change.

### Neutral
- The `bulk-upload` tile slot is freed; a future bulk-data-recovery feature would need its own ADR if one is ever needed.
- The state machine gains one new state (`historical_imported`) and two new transitions; the EDITABLE_STATES set is unchanged (historical_imported is locked, requires amendment first).

## Related ADRs
- ADR-0007 — Audit log: append-only retention
- ADR-0019 / ADR-0019.1 / ADR-0019.2 — Bonus management system (cadence, signature chains)
- ADR-0020 — Vision Dashboard tile registry
- ADR-0021 — Payroll mail-send via M365 Graph
