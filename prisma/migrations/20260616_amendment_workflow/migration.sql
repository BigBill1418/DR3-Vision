-- ADR-0028: Bonus daily-entry prior-day amendment workflow.
-- Pure additive — no existing tables touched.

CREATE TYPE "BonusAmendmentRequestState" AS ENUM (
  'pending',
  'approved',
  'rejected',
  'cancelled'
);

CREATE TYPE "BonusAmendmentChangeType" AS ENUM (
  'update',
  'insert'
);

CREATE TABLE "bonus_amendment_requests" (
  -- NOTE: id/FK columns are TEXT, not UUID. This database stores all primary
  -- keys as TEXT (Prisma `String @default(uuid())` → text), so UUID-typed FK
  -- columns are incompatible with the referenced TEXT ids (fixed 2026-06-16).
  "id"                          TEXT NOT NULL,
  "bonus_pay_period_id"         TEXT NOT NULL,
  "site_id"                     TEXT NOT NULL,
  "target_entry_date"           DATE NOT NULL,
  "bonus_employee_id"           TEXT NOT NULL,
  "change_type"                 "BonusAmendmentChangeType" NOT NULL,
  "old_value"                   JSONB,
  "new_value"                   JSONB NOT NULL,
  "justification"               TEXT NOT NULL,
  "requested_by_user_id"        TEXT NOT NULL,
  "requested_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state"                       "BonusAmendmentRequestState" NOT NULL DEFAULT 'pending',
  "expected_approver_user_id"   TEXT NOT NULL,
  "bill_pinged_at"              TIMESTAMP(3),
  "reviewed_by_user_id"         TEXT,
  "reviewed_at"                 TIMESTAMP(3),
  "decision_notes"              TEXT,
  "applied_audit_id"            TEXT,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bonus_amendment_requests_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "bonus_amendment_requests_period_fk"
    FOREIGN KEY ("bonus_pay_period_id") REFERENCES "bonus_pay_periods"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_employee_fk"
    FOREIGN KEY ("bonus_employee_id") REFERENCES "bonus_employees"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_requester_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_expected_approver_fk"
    FOREIGN KEY ("expected_approver_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_reviewer_fk"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_applied_audit_fk"
    FOREIGN KEY ("applied_audit_id") REFERENCES "audit_log"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT "bonus_amendment_requests_requester_neq_approver"
    CHECK ("requested_by_user_id" <> "expected_approver_user_id"),

  CONSTRAINT "bonus_amendment_requests_justification_min_length"
    CHECK (char_length("justification") >= 20),

  CONSTRAINT "bonus_amendment_requests_decided_has_reviewer"
    CHECK (
      ("state" = 'pending')
      OR ("state" = 'cancelled')
      OR ("reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    ),

  CONSTRAINT "bonus_amendment_requests_rejected_has_reason"
    CHECK ("state" <> 'rejected' OR "decision_notes" IS NOT NULL)
);

CREATE INDEX "bonus_amendment_requests_period_idx"
  ON "bonus_amendment_requests"("bonus_pay_period_id");

CREATE INDEX "bonus_amendment_requests_site_state_idx"
  ON "bonus_amendment_requests"("site_id", "state");

CREATE INDEX "bonus_amendment_requests_expected_approver_state_idx"
  ON "bonus_amendment_requests"("expected_approver_user_id", "state");

CREATE INDEX "bonus_amendment_requests_requester_idx"
  ON "bonus_amendment_requests"("requested_by_user_id");

CREATE INDEX "bonus_amendment_requests_target_idx"
  ON "bonus_amendment_requests"("bonus_employee_id", "target_entry_date");
