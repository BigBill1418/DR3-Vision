-- CreateEnum
CREATE TYPE "Jurisdiction" AS ENUM ('oregon', 'california');

-- CreateEnum
CREATE TYPE "BillingCadence" AS ENUM ('end_of_month_only', 'mid_month_and_end');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('operator', 'manager', 'admin');

-- CreateEnum
CREATE TYPE "UserLocale" AS ENUM ('en', 'es', 'ur');

-- CreateEnum
CREATE TYPE "LoadSourceType" AS ENUM ('b2b_haul', 'cip_consumer');

-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM ('expected', 'arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished', 'submitted', 'verified', 'rejected', 'submitted_to_mymrc', 'processed');

-- CreateEnum
CREATE TYPE "CountMode" AS ENUM ('ledger', 'multiplier', 'total');

-- CreateEnum
CREATE TYPE "RejectionCategory" AS ENUM ('contamination', 'damaged', 'wet', 'bedbugs', 'short', 'mislabeled', 'other');

-- CreateEnum
CREATE TYPE "ConcernCategory" AS ENUM ('damaged', 'wet', 'bedbugs', 'contamination', 'short', 'mislabeled', 'other');

-- CreateEnum
CREATE TYPE "PhotoKind" AS ENUM ('bol', 'weight_ticket', 'door_open', 'concern', 'rejection');

-- CreateEnum
CREATE TYPE "Shift" AS ENUM ('morning', 'afternoon', 'evening');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('unmatched_in_dr3', 'unmatched_in_mymrc', 'count_mismatch', 'weight_mismatch', 'resolved');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('insert', 'update', 'delete', 'soft_delete', 'restore');

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "mrc_program_code" TEXT NOT NULL,
    "max_units_indoor" INTEGER,
    "max_units_outdoor" INTEGER,
    "max_units_total_on_site" INTEGER,
    "customer_service_open" TEXT NOT NULL,
    "customer_service_close" TEXT NOT NULL,
    "recycling_rate_target_pct" DECIMAL(5,2) NOT NULL,
    "records_retention_years" INTEGER NOT NULL,
    "inbound_processing_deadline_days" INTEGER NOT NULL,
    "mymrc_inbound_submission_business_days" INTEGER NOT NULL,
    "mymrc_processed_submission_business_days" INTEGER NOT NULL,
    "dock_sla_minutes" INTEGER NOT NULL,
    "reconciliation_target_pct" DECIMAL(5,2) NOT NULL,
    "billing_cadence" "BillingCadence" NOT NULL,
    "cip_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_holidays" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "holiday_date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "site_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_billing_rates" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "per_unit_rate_usd" DECIMAL(10,4) NOT NULL,
    "effective_date" DATE NOT NULL,
    "end_date" DATE,
    "notes" TEXT,

    CONSTRAINT "site_billing_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_inventory_snapshots" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "units_indoor" INTEGER,
    "units_outdoor" INTEGER,
    "units_total" INTEGER,
    "units_in_processing" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "site_inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "locale" "UserLocale" NOT NULL DEFAULT 'en',
    "password_hash" TEXT,
    "pin_hash" TEXT,
    "pin_failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "pin_locked_until" TIMESTAMP(3),
    "primary_site_id" TEXT,
    "processor_role" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "street" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transporters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transporters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expected_loads" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "external_mymrc_haul_id" TEXT NOT NULL,
    "expected_arrival_at" TIMESTAMP(3) NOT NULL,
    "source_id" TEXT,
    "source_name_at_sync" TEXT NOT NULL,
    "transporter_id" TEXT,
    "transporter_name_at_sync" TEXT,
    "expected_unit_count" INTEGER,
    "bol_number" TEXT,
    "scheduled_at_mymrc" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "expected_loads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_loads" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "expected_load_id" TEXT,
    "load_source_type" "LoadSourceType" NOT NULL DEFAULT 'b2b_haul',
    "bol_number" TEXT,
    "source_id" TEXT,
    "transporter_id" TEXT,
    "assigned_operator_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "submitted_by_id" TEXT,
    "status" "LoadStatus" NOT NULL DEFAULT 'expected',
    "dock_appointment_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "weight_captured_at" TIMESTAMP(3),
    "unload_started_at" TIMESTAMP(3),
    "unload_finished_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "time_to_unload_start_seconds" INTEGER,
    "unload_duration_seconds" INTEGER,
    "total_units" INTEGER,
    "count_mode" "CountMode",
    "weight_lbs" INTEGER,
    "rejection_category" "RejectionCategory",
    "rejection_note" TEXT,
    "external_mymrc_haul_id" TEXT,
    "external_mymrc_materials_id" TEXT,
    "mymrc_submission_deadline" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_loads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_stacks" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "stack_index" INTEGER NOT NULL,
    "unit_count" INTEGER NOT NULL,
    "count_mode" "CountMode" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_stacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_photos" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "kind" "PhotoKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "annotation_storage_key" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "byte_size" INTEGER,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "load_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_concerns" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "category" "ConcernCategory" NOT NULL,
    "note" TEXT,
    "note_locale" "UserLocale",
    "voice_note_storage_key" TEXT,
    "raised_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_concerns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_sessions" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "processor_user_id" TEXT NOT NULL,
    "session_date" DATE NOT NULL,
    "shift" "Shift" NOT NULL,
    "line_no" INTEGER,
    "lead_user_id" TEXT,
    "authorized_by_user_id" TEXT,
    "units_handled" INTEGER NOT NULL DEFAULT 0,
    "units_processed" INTEGER NOT NULL DEFAULT 0,
    "units_saved" INTEGER NOT NULL DEFAULT 0,
    "units_leftover" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "submitted_to_mymrc_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processor_bonus_rules" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "threshold_low" INTEGER NOT NULL,
    "rate_low" DECIMAL(10,4) NOT NULL,
    "threshold_high" INTEGER NOT NULL,
    "rate_high" DECIMAL(10,4) NOT NULL,
    "effective_date" DATE NOT NULL,
    "end_date" DATE,
    "notes" TEXT,

    CONSTRAINT "processor_bonus_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mymrc_reconciliations" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "uploaded_by_id" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_rows" INTEGER NOT NULL,
    "matched_count" INTEGER NOT NULL,
    "unmatched_count" INTEGER NOT NULL,
    "resolved_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mymrc_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mymrc_reconciliation_items" (
    "id" TEXT NOT NULL,
    "reconciliation_id" TEXT NOT NULL,
    "external_haul_id" TEXT NOT NULL,
    "external_delivery_date" DATE,
    "external_unit_count" INTEGER,
    "external_weight_lbs" INTEGER,
    "matched_load_id" TEXT,
    "status" "ReconciliationStatus" NOT NULL,
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,

    CONSTRAINT "mymrc_reconciliation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_label" TEXT,
    "action" "AuditAction" NOT NULL,
    "table_name" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_templates" (
    "id" TEXT NOT NULL,
    "site_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema_json" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sites_code_key" ON "sites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "site_holidays_site_id_holiday_date_key" ON "site_holidays"("site_id", "holiday_date");

-- CreateIndex
CREATE INDEX "site_billing_rates_site_id_effective_date_idx" ON "site_billing_rates"("site_id", "effective_date");

-- CreateIndex
CREATE INDEX "site_inventory_snapshots_site_id_snapshot_at_idx" ON "site_inventory_snapshots"("site_id", "snapshot_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sources_site_id_is_active_idx" ON "sources"("site_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "sources_site_id_name_key" ON "sources"("site_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "transporters_name_key" ON "transporters"("name");

-- CreateIndex
CREATE UNIQUE INDEX "expected_loads_external_mymrc_haul_id_key" ON "expected_loads"("external_mymrc_haul_id");

-- CreateIndex
CREATE INDEX "expected_loads_site_id_expected_arrival_at_idx" ON "expected_loads"("site_id", "expected_arrival_at");

-- CreateIndex
CREATE INDEX "expected_loads_cancelled_at_idx" ON "expected_loads"("cancelled_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_loads_expected_load_id_key" ON "inbound_loads"("expected_load_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_loads_external_mymrc_haul_id_key" ON "inbound_loads"("external_mymrc_haul_id");

-- CreateIndex
CREATE INDEX "inbound_loads_site_id_status_idx" ON "inbound_loads"("site_id", "status");

-- CreateIndex
CREATE INDEX "inbound_loads_site_id_arrived_at_idx" ON "inbound_loads"("site_id", "arrived_at");

-- CreateIndex
CREATE INDEX "inbound_loads_assigned_operator_id_status_idx" ON "inbound_loads"("assigned_operator_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "load_stacks_load_id_stack_index_key" ON "load_stacks"("load_id", "stack_index");

-- CreateIndex
CREATE INDEX "load_photos_load_id_kind_idx" ON "load_photos"("load_id", "kind");

-- CreateIndex
CREATE INDEX "load_concerns_load_id_idx" ON "load_concerns"("load_id");

-- CreateIndex
CREATE INDEX "processing_sessions_site_id_session_date_idx" ON "processing_sessions"("site_id", "session_date");

-- CreateIndex
CREATE INDEX "processor_bonus_rules_site_id_effective_date_idx" ON "processor_bonus_rules"("site_id", "effective_date");

-- CreateIndex
CREATE INDEX "mymrc_reconciliations_site_id_period_start_idx" ON "mymrc_reconciliations"("site_id", "period_start");

-- CreateIndex
CREATE INDEX "mymrc_reconciliation_items_external_haul_id_idx" ON "mymrc_reconciliation_items"("external_haul_id");

-- CreateIndex
CREATE INDEX "audit_log_table_name_row_id_idx" ON "audit_log"("table_name", "row_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_created_at_idx" ON "audit_log"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_templates_code_key" ON "form_templates"("code");

-- AddForeignKey
ALTER TABLE "site_holidays" ADD CONSTRAINT "site_holidays_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_billing_rates" ADD CONSTRAINT "site_billing_rates_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_inventory_snapshots" ADD CONSTRAINT "site_inventory_snapshots_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_primary_site_id_fkey" FOREIGN KEY ("primary_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expected_loads" ADD CONSTRAINT "expected_loads_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expected_loads" ADD CONSTRAINT "expected_loads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expected_loads" ADD CONSTRAINT "expected_loads_transporter_id_fkey" FOREIGN KEY ("transporter_id") REFERENCES "transporters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_loads" ADD CONSTRAINT "inbound_loads_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_loads" ADD CONSTRAINT "inbound_loads_expected_load_id_fkey" FOREIGN KEY ("expected_load_id") REFERENCES "expected_loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_loads" ADD CONSTRAINT "inbound_loads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_loads" ADD CONSTRAINT "inbound_loads_transporter_id_fkey" FOREIGN KEY ("transporter_id") REFERENCES "transporters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_loads" ADD CONSTRAINT "inbound_loads_assigned_operator_id_fkey" FOREIGN KEY ("assigned_operator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_loads" ADD CONSTRAINT "inbound_loads_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_stacks" ADD CONSTRAINT "load_stacks_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "inbound_loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_photos" ADD CONSTRAINT "load_photos_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "inbound_loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_concerns" ADD CONSTRAINT "load_concerns_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "inbound_loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_sessions" ADD CONSTRAINT "processing_sessions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_sessions" ADD CONSTRAINT "processing_sessions_processor_user_id_fkey" FOREIGN KEY ("processor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_sessions" ADD CONSTRAINT "processing_sessions_lead_user_id_fkey" FOREIGN KEY ("lead_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_sessions" ADD CONSTRAINT "processing_sessions_authorized_by_user_id_fkey" FOREIGN KEY ("authorized_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processor_bonus_rules" ADD CONSTRAINT "processor_bonus_rules_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mymrc_reconciliation_items" ADD CONSTRAINT "mymrc_reconciliation_items_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "mymrc_reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
