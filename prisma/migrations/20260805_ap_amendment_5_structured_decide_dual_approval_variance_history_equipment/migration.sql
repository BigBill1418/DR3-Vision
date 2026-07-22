-- 2026-07-22 (operator-directed, Bill) — ADR-0046 Amendment 5: approver-side
-- vetting friction. Kelsey's post-live feedback ("performative approval is worse
-- than no approval") turns into structural friction on the APPROVE path —
-- structured decide input, auto-extracted amount, a $1,000 dual-approval hop,
-- vendor-baseline variance detection, invoice-history search, and equipment
-- linking. This migration lays the DATA foundation for all of it: new
-- ap_requests columns, one status-enum value, three support enums, five new
-- tables (vendor baseline history + computed baselines + equipment master +
-- second-approver roster + the request↔equipment join), and a one-time backfill
-- of the DEPRECATED vendor/amount_cents into the new structured columns.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant — replays on an empty PG16 in
-- CI, in ordinal order, AFTER 20260804_adr0057_phase1_real_mirrors). The repo
-- uses MONOTONIC ORDINAL migration names (…801, …802, …803, …804), NOT calendar
-- dates; 20260805 sorts after the applied MyMRC migrations so the clean-replay
-- order is correct (the "20260722" the handoff text suggested would sort BEFORE
-- them and break replay — deliberately NOT used).
--
-- DEPRECATE-not-drop (hard rule #1): ap_requests.vendor and ap_requests.amount_cents
-- are KEPT (historical data lives in them); the decide service stops WRITING them
-- and writes vendor_freeform / confirmed_amount_cents instead. The two UPDATE
-- statements below backfill any existing values so no data is stranded.
--
-- Backfill-safety of every DEFAULT / NOT NULL added to the EXISTING ap_requests
-- table (the only populated table this touches; all five new tables are empty
-- CREATEs):
--   * extracted_haul_numbers TEXT[] DEFAULT ARRAY[]::TEXT[] — every existing row
--     backfills to an EMPTY array (D-M5-7 Phase-2 hook; NO code populates it in
--     Phase 1). Column mirrors Prisma's scalar-list DDL exactly (Prisma keeps the
--     array column DB-nullable while the client always writes an array).
--   * variance_flag_state "ApVarianceFlagState" NOT NULL DEFAULT 'not_applicable'
--     — every existing row backfills to not_applicable (no variance evaluated on
--     already-decided rows).
--   * all other new ap_requests columns are NULLABLE (no backfill hazard).
--   * users.can_view_ap_history BOOLEAN NOT NULL DEFAULT false — every existing
--     user backfills to "no history access" (admins are granted implicitly in
--     code, not by this column).

-- ── Status enum: add the dual-approval hop, positioned BEFORE 'approved' so this
-- value sits immediately before 'approved' (matching its neighbor placement in
-- schema.prisma). NOTE: the OVERALL DB enum value order does NOT — and cannot —
-- match schema.prisma: 20260716 appended 'pending_review' with a bare `ADD VALUE`
-- (no BEFORE), so in the DB it lands at the END while schema.prisma declares it
-- second. That divergence is harmless: Postgres enum value ORDER does not affect
-- Prisma correctness or `migrate diff` (Prisma diffs the SET of values, not their
-- physical order). Not USED anywhere in this migration, so ADD VALUE is
-- transaction-safe on PG12+. ─────────────────────────────────────────────────
ALTER TYPE "ApRequestStatus" ADD VALUE IF NOT EXISTS 'pending_second_approval' BEFORE 'approved';

-- ── New support enums (D-M5-4 / D-M5-6). ────────────────────────────────────
CREATE TYPE "ApVarianceFlagState" AS ENUM ('not_applicable', 'below_threshold', 'above_threshold', 'acknowledged');
CREATE TYPE "ApBaselineHistorySource" AS ENUM ('bill_upload', 'vision_approval');
CREATE TYPE "EquipmentCategory" AS ENUM ('vehicle', 'forklift', 'baler', 'terex', 'other');

-- ── D-M5-5 capability: AP invoice-history read access (admins implicit + granted
-- to non-admin second approvers). ───────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "can_view_ap_history" BOOLEAN NOT NULL DEFAULT false;

-- ── ap_requests: structured decide + extraction + dual approval + variance +
-- Phase-2 haul hook. All ADDITIVE. ──────────────────────────────────────────
ALTER TABLE "ap_requests"
    ADD COLUMN "vendor_freeform" TEXT,
    ADD COLUMN "explanation" TEXT,
    ADD COLUMN "confirmed_amount_cents" INTEGER,
    ADD COLUMN "extraction" JSONB,
    ADD COLUMN "extracted_haul_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "first_approver_id" TEXT,
    ADD COLUMN "first_approved_at" TIMESTAMP(3),
    ADD COLUMN "second_approver_id" TEXT,
    ADD COLUMN "second_approved_at" TIMESTAMP(3),
    ADD COLUMN "second_approver_note" TEXT,
    ADD COLUMN "variance_flag_state" "ApVarianceFlagState" NOT NULL DEFAULT 'not_applicable',
    ADD COLUMN "variance_acknowledged_by" TEXT,
    ADD COLUMN "variance_acknowledged_at" TIMESTAMP(3),
    ADD COLUMN "variance_acknowledgment_note" TEXT;

-- One-time backfill of the DEPRECATED columns into the new structured columns
-- (hard rule #1). Idempotent + no-op on the empty CI DB.
UPDATE "ap_requests"
    SET "vendor_freeform" = "vendor"
    WHERE "vendor" IS NOT NULL AND "vendor_freeform" IS NULL;
UPDATE "ap_requests"
    SET "confirmed_amount_cents" = "amount_cents"
    WHERE "amount_cents" IS NOT NULL AND "confirmed_amount_cents" IS NULL;

-- History-search / baseline-lookup indexes on the new ap_requests columns.
CREATE INDEX "ap_requests_vendor_freeform_idx" ON "ap_requests"("vendor_freeform");
CREATE INDEX "ap_requests_first_approver_id_idx" ON "ap_requests"("first_approver_id");
CREATE INDEX "ap_requests_second_approver_id_idx" ON "ap_requests"("second_approver_id");

-- ── D-M5-4: ap_vendor_baseline_history — raw AP-history rows (Bill uploads +
-- Vision approvals). ────────────────────────────────────────────────────────
CREATE TABLE "ap_vendor_baseline_history" (
    "id" TEXT NOT NULL,
    "vendor_name" TEXT NOT NULL,
    "vendor_name_normalized" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "invoice_amount_cents" INTEGER NOT NULL,
    "site_id" TEXT,
    "source" "ApBaselineHistorySource" NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "imported_by" TEXT,

    CONSTRAINT "ap_vendor_baseline_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ap_vendor_baseline_history_vendor_name_normalized_idx" ON "ap_vendor_baseline_history"("vendor_name_normalized");
CREATE INDEX "ap_vendor_baseline_history_site_id_idx" ON "ap_vendor_baseline_history"("site_id");
CREATE INDEX "ap_vendor_baseline_history_invoice_date_idx" ON "ap_vendor_baseline_history"("invoice_date");

-- site_id → sites.id (bare FK; nullable — a combined upload may not resolve a site).
ALTER TABLE "ap_vendor_baseline_history"
    ADD CONSTRAINT "ap_vendor_baseline_history_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── D-M5-4: ap_vendor_baselines — computed per-vendor aggregates (refreshed
-- nightly + on-demand). PK is the normalized vendor name. ────────────────────
CREATE TABLE "ap_vendor_baselines" (
    "vendor_name_normalized" TEXT NOT NULL,
    "vendor_display_name" TEXT NOT NULL,
    "invoice_count" INTEGER NOT NULL,
    "mean_amount_cents" INTEGER NOT NULL,
    "median_amount_cents" INTEGER NOT NULL,
    "min_amount_cents" INTEGER NOT NULL,
    "max_amount_cents" INTEGER NOT NULL,
    "stddev_amount_cents" INTEGER,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "variance_flat_override_cents" INTEGER,
    "variance_percent_override" DECIMAL(6,4),

    CONSTRAINT "ap_vendor_baselines_pkey" PRIMARY KEY ("vendor_name_normalized")
);

-- ── D-M5-6: equipment — the consolidated asset master (site_id + is_active per
-- spec). No master existed before Amendment 5 (equipment_events is a Terex-first
-- LOG). Admin-managed; the approver panel only REFERENCES rows. ──────────────
CREATE TABLE "equipment" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "category" "EquipmentCategory" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "equipment_site_id_is_active_idx" ON "equipment"("site_id", "is_active");

ALTER TABLE "equipment"
    ADD CONSTRAINT "equipment_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── D-M5-6: ap_equipment_links — request ↔ equipment join (or the explicit
-- "Not equipment-related" marker row). ──────────────────────────────────────
CREATE TABLE "ap_equipment_links" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "equipment_id" TEXT,
    "is_not_equipment_related" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ap_equipment_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ap_equipment_links_request_id_idx" ON "ap_equipment_links"("request_id");
CREATE INDEX "ap_equipment_links_equipment_id_idx" ON "ap_equipment_links"("equipment_id");

-- request_id → ap_requests.id (Prisma relation, cascade delete).
ALTER TABLE "ap_equipment_links"
    ADD CONSTRAINT "ap_equipment_links_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "ap_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- equipment_id → equipment.id (Prisma relation, RESTRICT — never orphan a link by
-- deleting a referenced asset; deactivate via is_active instead).
ALTER TABLE "ap_equipment_links"
    ADD CONSTRAINT "ap_equipment_links_equipment_id_fkey"
    FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── D-M5-3: ap_second_approvers — the $1,000 second-approval roster, keyed by
-- SITE CODE ('woodland' | 'eugene'; NOT-DR3 has no second approver). ─────────
CREATE TABLE "ap_second_approvers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "active_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ap_second_approvers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ap_second_approvers_site_id_active_idx" ON "ap_second_approvers"("site_id", "active");
CREATE INDEX "ap_second_approvers_user_id_idx" ON "ap_second_approvers"("user_id");

-- site_id domain guard: the roster is keyed by the site CODE, not a sites.id FK.
ALTER TABLE "ap_second_approvers"
    ADD CONSTRAINT "ap_second_approvers_site_id_chk"
    CHECK ("site_id" IN ('woodland', 'eugene'));

-- user_id → users.id (bare FK, matches ap_approvers_user_id_fkey).
ALTER TABLE "ap_second_approvers"
    ADD CONSTRAINT "ap_second_approvers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
