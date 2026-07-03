-- ADR-0039 — 3-way audit engine + Audit Workbench + retro-audit.
--
-- Purely additive: seven enum types + five tables (audit_findings,
-- audit_check_config, workbook_imports, workbook_import_rows staging, and the
-- audit_runs ledger). No existing table is altered. ids/FKs are TEXT to match
-- this repo's convention (users.id / sites.id are TEXT; Prisma generates the id
-- app-side). Clean-replays on an empty PG16 in CI (ADR-0035 invariant) because
-- every FK target (sites, users) is created by earlier migrations.
--
-- The audit compares three INDEPENDENT legs (Vision ops data ADR-0037, MyMRC
-- mirrors ADR-0038, billing/workbooks) — none of these tables feed the
-- operational tables; findings never mutate source data.

-- CreateEnum
CREATE TYPE "AuditCheckCode" AS ENUM ('c1_inbound', 'c2_processed', 'c3_outbound', 'c4_billing_basis', 'c5_conservation', 'c6_inventory_continuity', 'c7_deadline', 'summary_recompute');

-- CreateEnum
CREATE TYPE "AuditFindingKind" AS ENUM ('missing_counterpart', 'value_mismatch', 'date_mismatch', 'unresolved_site', 'dropped_row');

-- CreateEnum
CREATE TYPE "AuditFindingStatus" AS ENUM ('open', 'acknowledged', 'resolved', 'not_an_issue');

-- CreateEnum
CREATE TYPE "AuditFindingCause" AS ENUM ('data_entry', 'operational', 'external_mymrc', 'template_defect', 'unknown');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "AuditRunStatus" AS ENUM ('ok', 'partial', 'error');

-- CreateEnum
CREATE TYPE "WorkbookImportStatus" AS ENUM ('uploaded', 'parsing', 'parsed', 'failed');

-- CreateTable
CREATE TABLE "audit_findings" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "check_code" "AuditCheckCode" NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "severity" "AuditSeverity" NOT NULL,
    "finding_kind" "AuditFindingKind" NOT NULL,
    "leg_a_ref" TEXT,
    "leg_b_ref" TEXT,
    "expected" JSONB,
    "actual" JSONB,
    "detail_json" JSONB,
    "fingerprint" TEXT NOT NULL,
    "status" "AuditFindingStatus" NOT NULL DEFAULT 'open',
    "cause_category" "AuditFindingCause",
    "resolution_note" TEXT,
    "resolved_by_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "import_id" TEXT,
    "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_check_config" (
    "id" TEXT NOT NULL,
    "site_id" TEXT,
    "check_code" "AuditCheckCode" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "AuditSeverity" NOT NULL DEFAULT 'medium',
    "unit_tolerance" INTEGER NOT NULL DEFAULT 0,
    "weight_tolerance_lbs" INTEGER NOT NULL DEFAULT 0,
    "grace_business_days" INTEGER NOT NULL DEFAULT 0,
    "open_window_days" INTEGER,
    "blocks_billing" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_check_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_imports" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "storage_key" TEXT,
    "template_generation" TEXT,
    "period_label" TEXT,
    "status" "WorkbookImportStatus" NOT NULL DEFAULT 'uploaded',
    "uploaded_by_user_id" TEXT NOT NULL,
    "parse_error" TEXT,
    "sheet_count" INTEGER,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_import_rows" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "tab_name" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "col_ref" TEXT NOT NULL,
    "section" TEXT,
    "field_key" TEXT,
    "raw_value" TEXT,
    "numeric_value" DECIMAL(14,2),
    "site_name_raw" TEXT,
    "resolved_site_id" TEXT,
    "provenance" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_runs" (
    "id" TEXT NOT NULL,
    "site_id" TEXT,
    "trigger" TEXT NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "status" "AuditRunStatus" NOT NULL DEFAULT 'ok',
    "checks_run" TEXT[],
    "findings_opened" INTEGER NOT NULL DEFAULT 0,
    "findings_updated" INTEGER NOT NULL DEFAULT 0,
    "findings_resolved" INTEGER NOT NULL DEFAULT 0,
    "error_text" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_findings_fingerprint_key" ON "audit_findings"("fingerprint");

-- CreateIndex
CREATE INDEX "audit_findings_site_id_status_idx" ON "audit_findings"("site_id", "status");

-- CreateIndex
CREATE INDEX "audit_findings_site_id_check_code_window_start_idx" ON "audit_findings"("site_id", "check_code", "window_start");

-- CreateIndex
CREATE INDEX "audit_findings_import_id_idx" ON "audit_findings"("import_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_check_config_site_id_check_code_key" ON "audit_check_config"("site_id", "check_code");

-- CreateIndex
CREATE INDEX "workbook_imports_site_id_created_at_idx" ON "workbook_imports"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "workbook_import_rows_import_id_tab_name_idx" ON "workbook_import_rows"("import_id", "tab_name");

-- CreateIndex
CREATE INDEX "audit_runs_site_id_started_at_idx" ON "audit_runs"("site_id", "started_at");

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "workbook_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_check_config" ADD CONSTRAINT "audit_check_config_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_imports" ADD CONSTRAINT "workbook_imports_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_imports" ADD CONSTRAINT "workbook_imports_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_import_rows" ADD CONSTRAINT "workbook_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "workbook_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
