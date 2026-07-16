-- ADR-0052 — commodity payment reconciliation (v1, Daven Stetson). Companion
-- table to outbound_materials: one row per tracked load (absent row =
-- implicitly awaiting_invoice). Manual entry at v1; statuses are forward
-- transitions with provenance, history append-only in audit_log. PURELY
-- ADDITIVE (ADR-0035 clean-replay).
CREATE TYPE "CommodityPaymentStatus" AS ENUM ('awaiting_invoice', 'invoiced', 'paid', 'disputed');

CREATE TABLE "outbound_material_payments" (
    "id" TEXT NOT NULL,
    "outbound_material_id" TEXT NOT NULL,
    "status" "CommodityPaymentStatus" NOT NULL DEFAULT 'awaiting_invoice',
    "buyer_invoice_ref" TEXT,
    "expected_amount" DECIMAL(12,2),
    "invoiced_at" DATE,
    "paid_at" DATE,
    "notes" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_material_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbound_material_payments_outbound_material_id_key" ON "outbound_material_payments"("outbound_material_id");
CREATE INDEX "outbound_material_payments_status_idx" ON "outbound_material_payments"("status");

ALTER TABLE "outbound_material_payments" ADD CONSTRAINT "outbound_material_payments_outbound_material_id_fkey" FOREIGN KEY ("outbound_material_id") REFERENCES "outbound_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
