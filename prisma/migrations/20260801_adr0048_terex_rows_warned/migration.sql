-- ADR-0048 D3 — Terex importer date-plausibility hardening.
--
-- exceljs surfaces a bare number typed into a date-FORMATTED cell as an
-- Excel-epoch Date (a stray "14" becomes 1900-01-14). A maintenance-log row that
-- carries real content (issue/measures/notes/cost/credit) but whose Date cell is
-- such an artifact is no longer stored as a garbage 1900 `equipment_events` row,
-- NOR silently dropped: it is surfaced to the operator as a warning so the Date
-- cell is fixed at the source. This column records how many such rows an import
-- flagged. PURELY ADDITIVE (ADR-0035 clean-replay) — NOT NULL DEFAULT 0.
ALTER TABLE "equipment_history_imports" ADD COLUMN "rows_warned" INTEGER NOT NULL DEFAULT 0;
