-- ADR-0068 — employee reimbursement requests: structured intake + mandatory dual approval.
--
-- WHY: Mary Scott (SVdP accounting) reported that Janette was approving her own
-- reimbursement submissions. The old path was paper → scan → email Mary → Mary
-- forwards into the AP mailbox → the shared AP queue, where the ORIGINATOR was
-- invisible to Vision: it knew who forwarded (Mary) and who approved (Janette),
-- while the originator existed only as ink inside a scanned PDF. First-action-wins
-- then did exactly what it was designed to do. The approval stamp was manufacturing
-- audit evidence for a review that never happened.
--
-- THE TWO CHECK CONSTRAINTS BELOW ARE THE POINT OF THIS MIGRATION. The control Mary
-- caught failing must be IMPOSSIBLE at the storage layer, not merely discouraged in
-- application code. Application guards get refactored; a CHECK does not.
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty PG16
-- in CI). One new table, three new enums, no alterations to existing objects.
--
-- `id` / FK columns are TEXT per the repo's hand-written-migration rule. A
-- `uuid`-typed id passes CI (which does not run migrations) and fails only on
-- deploy, taking the app down.

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ReimbursementCategory" AS ENUM ('mileage', 'fuel', 'supplies', 'meals', 'tools', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReimbursementStatus" AS ENUM ('pending_second_approval', 'approved', 'rejected', 'held');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReimbursementEscalationReason" AS ENUM ('timeout', 'beneficiary_conflict', 'no_routing_row', 'ambiguous_beneficiary');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── The table ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reimbursement_requests" (
  "id"                     TEXT PRIMARY KEY,
  -- Auto-filled from the submitter, never client-chosen (hard rule #2: site reach
  -- is a server decision). NOT NULL — a reimbursement always belongs to a site.
  "site_id"                TEXT NOT NULL,

  -- Beneficiary: roster pick OR free text, never both, never neither.
  "employee_user_id"       TEXT,
  "employee_name_freeform" TEXT,

  "amount_cents"           INTEGER NOT NULL,
  -- The EXPENSE date, not the submission date. `date` not timestamp: an expense
  -- happened on a day, and storing an instant would invite a timezone bug in a
  -- Pacific-operating org whose servers run UTC.
  "expense_date"           DATE NOT NULL,
  "category"               "ReimbursementCategory" NOT NULL,
  "purpose"                TEXT NOT NULL,
  -- R2 object key. Receipts NEVER live in this database (hard rule: photos to R2).
  "receipt_file_key"       TEXT NOT NULL,
  "receipt_content_type"   TEXT NOT NULL,

  -- First signature IS the submission (D4). The submitting manager is
  -- authenticated, which is the whole reason this control can exist.
  "submitted_by"           TEXT NOT NULL,
  "submitted_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Second signature.
  "status"                 "ReimbursementStatus" NOT NULL DEFAULT 'pending_second_approval',
  "second_approver_id"     TEXT,
  "second_approved_at"     TIMESTAMP(3),
  "decision_note"          TEXT,

  -- Routing / escalation.
  "routed_to_user_id"      TEXT NOT NULL,
  "escalated_at"           TIMESTAMP(3),
  "escalated_to"           TEXT,
  "escalation_reason"      "ReimbursementEscalationReason",

  -- Output.
  "decision_pdf_key"       TEXT,
  "decision_pdf_sha256"    TEXT,
  "sent_to_accounting_at"  TIMESTAMP(3),

  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- ══ CONTROL 1 — THE SUBMITTER CAN NEVER BE THE SECOND APPROVER ══════════
  -- This is the exact failure Mary caught. It is enforced in the resolver and in
  -- the UI as well, but THIS is the one that cannot be refactored away, cannot be
  -- bypassed by a hand-crafted request, and cannot be defeated by a future code
  -- path that forgets to ask. If this constraint ever fires in production, a real
  -- bug was stopped from becoming a real payment.
  CONSTRAINT "reimbursement_second_approver_not_submitter"
    CHECK ("second_approver_id" IS NULL OR "second_approver_id" <> "submitted_by"),

  -- ══ CONTROL 2 — EXACTLY ONE BENEFICIARY IDENTITY ════════════════════════
  -- Neither → nobody is being paid and the beneficiary-exclusion check (D6) has
  -- nothing to compare against, which would silently disable that control.
  -- Both → two answers to "who is being paid", and the exclusion check would have
  -- to guess which one to trust.
  CONSTRAINT "reimbursement_exactly_one_beneficiary"
    CHECK (("employee_user_id" IS NULL) <> ("employee_name_freeform" IS NULL)),

  -- Amount must be a real positive amount. A zero or negative reimbursement is
  -- not a reimbursement.
  CONSTRAINT "reimbursement_amount_positive" CHECK ("amount_cents" > 0),

  -- A refusal must say why (D7: reject and hold require a note; approve does not,
  -- because the substantive data was captured at submission).
  CONSTRAINT "reimbursement_refusal_has_note"
    CHECK ("status" NOT IN ('rejected', 'held') OR ("decision_note" IS NOT NULL AND btrim("decision_note") <> ''))
);

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- All RESTRICT: a reimbursement is a financial record with signatures on it.
-- Deleting a user or site out from under one must fail loudly, never cascade a
-- payment record into nonexistence.
DO $$ BEGIN
  ALTER TABLE "reimbursement_requests"
    ADD CONSTRAINT "reimbursement_requests_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reimbursement_requests"
    ADD CONSTRAINT "reimbursement_requests_employee_user_id_fkey"
    FOREIGN KEY ("employee_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reimbursement_requests"
    ADD CONSTRAINT "reimbursement_requests_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reimbursement_requests"
    ADD CONSTRAINT "reimbursement_requests_second_approver_id_fkey"
    FOREIGN KEY ("second_approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reimbursement_requests"
    ADD CONSTRAINT "reimbursement_requests_routed_to_user_id_fkey"
    FOREIGN KEY ("routed_to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Queue and 06:00 digest reads: "what is waiting on this person".
CREATE INDEX IF NOT EXISTS "reimbursement_requests_status_routed_to_user_id_idx"
  ON "reimbursement_requests" ("status", "routed_to_user_id");
-- Reporting: reimbursement spend per site over a period. This is the benefit that
-- comes free from structured intake — spend becomes queryable instead of a pile of
-- scans in a mailbox.
CREATE INDEX IF NOT EXISTS "reimbursement_requests_site_id_expense_date_idx"
  ON "reimbursement_requests" ("site_id", "expense_date");
-- The submitter's own read-only view of what they have filed.
CREATE INDEX IF NOT EXISTS "reimbursement_requests_submitted_by_idx"
  ON "reimbursement_requests" ("submitted_by");

-- ── Notification surface (ADR-0047), born pilot ─────────────────────────────
-- A NEW staff-facing output with a NEW recipient set (the routed peer, Mary,
-- the submitter), so it gets its OWN rollout row rather than riding `ap_notify`:
-- Bill must be able to ramp reimbursement mail independently of the AP queue's
-- broadcast. Born `pilot` (admins-only, with the would-have-sent header) per
-- CLAUDE.md hard rule #12.
--
-- Zero rows on a fresh CI replay (`sites` is seeded later by prisma/seed.mjs);
-- ON CONFLICT DO NOTHING so a replay never reverts a `live` flip.
INSERT INTO "rollout_surfaces"
  ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'notification', 'reimbursement_notify', s."id", 'pilot',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;

-- ── UI surface gate (ADR-0047 / ADR-0065) ───────────────────────────────────
-- The Employee Reimbursement tile itself. Born `pilot` so Bill can put it in
-- front of the Woodland managers before Eugene (spec §6.4 leaves the Eugene
-- question open), without a code change.
INSERT INTO "rollout_surfaces"
  ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'ui', 'reimbursement_tile', s."id", 'pilot',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
