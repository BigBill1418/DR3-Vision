-- 2026-07-09 rollup §8.1 items 3–5 (ADR-0041 addendum + ADR-0039 read surface).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Three shapes, all sourced from Mary Scott's survey response (rollup §1):
--   1. invoices gains the explicit GP "Trade discount" fields — the mid-month
--      amount already invoiced + the mid-month invoice it references (§1.3).
--      Populated only on ca_processing_eom drafts; the stored B22.offset line
--      still carries the negative (the total math is unchanged).
--   2. credit_memos — the over-billed correction path whose applying REQUIRES
--      MRC's acceptance (§1.4): proposed → sent_to_mrc → accepted | rejected →
--      applied | void_and_reissue_triggered.
--   3. users.can_view_billing_verify — read-only /admin/billing/verify access
--      for non-admin staff (Mary; §1.2). Grants exactly that one page.
--
-- The dir name `20260717_trade_discount_credit_memos_verify` sorts AFTER the
-- current chain tip (`20260716b_workbook_sync`), preserving ADR-0035 lexical
-- migration ordering.

-- AlterTable: explicit GP Trade discount fields (nullable; EOM-only population).
ALTER TABLE "invoices" ADD COLUMN "trade_discount_cents" INTEGER;
ALTER TABLE "invoices" ADD COLUMN "trade_discount_reference_invoice_id" TEXT;

-- Self-FK to the referenced mid-month invoice. SET NULL on delete: invoices are
-- never deleted in practice (void, never drop), so this is a belt guard only.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_trade_discount_reference_invoice_id_fkey"
  FOREIGN KEY ("trade_discount_reference_invoice_id") REFERENCES "invoices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum: the credit-memo state machine (transitions enforced in
-- src/lib/invoices/credit-memos.ts; every step audited).
CREATE TYPE "CreditMemoStatus" AS ENUM (
  'proposed',
  'sent_to_mrc',
  'accepted',
  'rejected',
  'applied',
  'void_and_reissue_triggered'
);

-- CreateTable: credit memos against APPROVED invoices. amount_cents is POSITIVE
-- (the credit owed back to MRC). created_by is a bare audit-actor user id
-- (ADR-0041 block convention); site_id carries a DB-level FK for scoped reads.
CREATE TABLE "credit_memos" (
  "id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "site_id" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "CreditMemoStatus" NOT NULL DEFAULT 'proposed',
  "superseding_invoice_id" TEXT,
  "created_by" TEXT,
  "sent_at" TIMESTAMP(3),
  "decided_at" TIMESTAMP(3),
  "decided_note" TEXT,
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_memos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "credit_memos_invoice_id_idx" ON "credit_memos"("invoice_id");
CREATE INDEX "credit_memos_site_id_status_idx" ON "credit_memos"("site_id", "status");

ALTER TABLE "credit_memos"
  ADD CONSTRAINT "credit_memos_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB-level FK for site scoping (mirrors the ADR-0040/0041 end-block convention:
-- constraint at the DB, no Prisma back-relation on Site).
ALTER TABLE "credit_memos"
  ADD CONSTRAINT "credit_memos_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: the read-only billing-verify permission (rollup §1.2).
ALTER TABLE "users" ADD COLUMN "can_view_billing_verify" BOOLEAN NOT NULL DEFAULT false;
