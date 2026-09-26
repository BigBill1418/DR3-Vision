-- ADR-0139 (2026-09-25) — `snapshot_source` doc-ingest anomaly kind.
--
-- A watched document that is an Outlook attachment copy (`root:/Attachments`)
-- and has not changed in weeks is a frozen snapshot, not the live workbook
-- ADR-0067 D1 promises. Nothing could say so: every sweep was truthfully `ok`
-- with zero new versions. This value lets the once-a-day check record it.
--
-- CLEAN-REPLAY SAFE (ADR-0035): ADD VALUE IF NOT EXISTS.
-- ROLLBACK: Postgres cannot drop an enum value; leave it (unused values are inert).

ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'snapshot_source';
