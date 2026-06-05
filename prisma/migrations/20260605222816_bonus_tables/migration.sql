-- CreateEnum
CREATE TYPE "BonusMonthState" AS ENUM ('draft', 'pending_signatures', 'partially_signed', 'signed', 'paid', 'amended');

-- CreateTable
CREATE TABLE "bonus_employees" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "previous_names" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "user_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "bonus_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonus_daily_entries" (
    "id" TEXT NOT NULL,
    "bonus_employee_id" TEXT NOT NULL,
    "bonus_month_id" TEXT NOT NULL,
    "entry_date" DATE NOT NULL,
    "mattress_count" INTEGER NOT NULL,
    "note" TEXT,
    "entered_by_user_id" TEXT NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_daily_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonus_months" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "month_start" DATE NOT NULL,
    "month_end" DATE NOT NULL,
    "state" "BonusMonthState" NOT NULL DEFAULT 'draft',
    "janette_signed_by_user_id" TEXT,
    "janette_signed_at" TIMESTAMP(3),
    "janette_signed_ip" TEXT,
    "janette_signed_user_agent" TEXT,
    "janette_override_actor_id" TEXT,
    "janette_override_reason" TEXT,
    "morena_signed_by_user_id" TEXT,
    "morena_signed_at" TIMESTAMP(3),
    "morena_signed_ip" TEXT,
    "morena_signed_user_agent" TEXT,
    "morena_override_actor_id" TEXT,
    "morena_override_reason" TEXT,
    "pdf_storage_key" TEXT,
    "pdf_generated_at" TIMESTAMP(3),
    "payroll_sent_at" TIMESTAMP(3),
    "payroll_message_id" TEXT,
    "payroll_retry_count" INTEGER NOT NULL DEFAULT 0,
    "amended_from_month_id" TEXT,
    "amendment_reason" TEXT,
    "amended_by_user_id" TEXT,
    "amended_at" TIMESTAMP(3),
    "total_payout_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bonus_months_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bonus_employees_site_id_is_active_idx" ON "bonus_employees"("site_id", "is_active");

-- CreateIndex
CREATE INDEX "bonus_daily_entries_bonus_month_id_idx" ON "bonus_daily_entries"("bonus_month_id");

-- CreateIndex
CREATE INDEX "bonus_daily_entries_entry_date_idx" ON "bonus_daily_entries"("entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "bonus_daily_entries_bonus_employee_id_entry_date_key" ON "bonus_daily_entries"("bonus_employee_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "bonus_months_amended_from_month_id_key" ON "bonus_months"("amended_from_month_id");

-- CreateIndex
CREATE INDEX "bonus_months_site_id_state_idx" ON "bonus_months"("site_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "bonus_months_site_id_month_start_key" ON "bonus_months"("site_id", "month_start");

-- AddForeignKey
ALTER TABLE "bonus_employees" ADD CONSTRAINT "bonus_employees_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_employees" ADD CONSTRAINT "bonus_employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_daily_entries" ADD CONSTRAINT "bonus_daily_entries_bonus_employee_id_fkey" FOREIGN KEY ("bonus_employee_id") REFERENCES "bonus_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_daily_entries" ADD CONSTRAINT "bonus_daily_entries_bonus_month_id_fkey" FOREIGN KEY ("bonus_month_id") REFERENCES "bonus_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_daily_entries" ADD CONSTRAINT "bonus_daily_entries_entered_by_user_id_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_months" ADD CONSTRAINT "bonus_months_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_months" ADD CONSTRAINT "bonus_months_janette_signed_by_user_id_fkey" FOREIGN KEY ("janette_signed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_months" ADD CONSTRAINT "bonus_months_morena_signed_by_user_id_fkey" FOREIGN KEY ("morena_signed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_months" ADD CONSTRAINT "bonus_months_amended_from_month_id_fkey" FOREIGN KEY ("amended_from_month_id") REFERENCES "bonus_months"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_months" ADD CONSTRAINT "bonus_months_amended_by_user_id_fkey" FOREIGN KEY ("amended_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
