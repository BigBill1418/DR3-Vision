-- ADR-0136 addendum (2026-09-23) — the same-file duplicate key.
--
-- The duplicate-approval guard keyed on the invoice number in the SUBJECT, so a
-- re-forward whose subject names no number ("FW: Ramos/EFuel", "FW: Invoice(s)
-- Posted") was approved again with a byte-identical PDF. `ap_attachments.sha256`
-- records the sha256 of each stored file so the guard can compare the files
-- themselves. Nullable: the Approve guard fills it for the request's invoice files,
-- and a one-off backfill (scripts/one-off/2026-09-23-ap-attachment-sha256-backfill.mjs)
-- filled every file stored before this migration. Indexed for the `IN (...)` lookup.
--
-- CLEAN-REPLAY SAFE (ADR-0035): every statement is guarded.
-- ROLLBACK: DROP INDEX IF EXISTS "ap_attachments_sha256_idx";
--           ALTER TABLE "ap_attachments" DROP COLUMN IF EXISTS "sha256";

ALTER TABLE "ap_attachments" ADD COLUMN IF NOT EXISTS "sha256" TEXT;

CREATE INDEX IF NOT EXISTS "ap_attachments_sha256_idx" ON "ap_attachments"("sha256");
