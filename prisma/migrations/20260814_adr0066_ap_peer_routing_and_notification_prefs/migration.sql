-- ADR-0066 §1.4/§1.5/§1.6 — person-to-person second-approval routing, per-user
-- notification prefs, and the weekday-clock escalation columns.
--
-- WHY: the AP authorization path accepted admin-eligibility while the NOTIFICATION
-- path resolved recipients from `ap_second_approvers WHERE site_id = <site>`. Bill
-- was deliberately never given a `woodland` roster row because admin-eligibility
-- covered his authority — so every Woodland second-approval request resolved to an
-- EMPTY recipient set. The notify path is fail-soft, so it sent nothing and raised
-- nothing. Invoices >= $1,000 sat unapproved and invisible. Shannon (an explicit
-- `eugene` row) was notified normally, which is why it looked healthy from the
-- Eugene side and would have passed any Eugene-side test.
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty PG16
-- in CI, where `users` is empty at this point — the seeds below are all guarded by
-- SELECTs over `users`, so they insert zero rows on a fresh replay and the real
-- values are carried by prisma/seed.mjs for dev parity).
--
-- `id` columns are TEXT (`gen_random_uuid()::text`) per the repo's hand-written
-- migration rule — a `uuid`-typed id passes CI (which does not run migrations) and
-- only fails on deploy, taking the app down.
--
-- `ap_second_approvers` is NOT dropped. ADR-0046 Amendment 5 wrote it, decisions
-- reference that history, and audit continuity outranks tidiness. We stop reading
-- it; the supersession is recorded in ADR-0046's amendment history.

-- ── §1.4 — routing table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ap_approval_routing" (
  "id"                   TEXT PRIMARY KEY,
  "first_approver_id"    TEXT NOT NULL,
  "second_approver_id"   TEXT NOT NULL,
  "fallback_approver_id" TEXT,
  "fallback_after_hours" INTEGER NOT NULL DEFAULT 24,
  "active"               BOOLEAN NOT NULL DEFAULT true,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  "updated_by"           TEXT
);

-- One routing row per first approver. This is what makes the table a total
-- function from first-approver → second-approver.
CREATE UNIQUE INDEX IF NOT EXISTS "ap_approval_routing_first_approver_id_key"
  ON "ap_approval_routing" ("first_approver_id");

CREATE INDEX IF NOT EXISTS "ap_approval_routing_active_idx"
  ON "ap_approval_routing" ("active");

-- Self-approval is never a valid pair. This is the storage-layer guarantee; the
-- resolver and the admin UI both also enforce it, but this is the one that cannot
-- be bypassed by a bug or a hand-crafted write.
ALTER TABLE "ap_approval_routing"
  DROP CONSTRAINT IF EXISTS "ap_approval_routing_no_self_approval";
ALTER TABLE "ap_approval_routing"
  ADD CONSTRAINT "ap_approval_routing_no_self_approval"
  CHECK ("first_approver_id" <> "second_approver_id");

DO $$ BEGIN
  ALTER TABLE "ap_approval_routing"
    ADD CONSTRAINT "ap_approval_routing_first_approver_id_fkey"
    FOREIGN KEY ("first_approver_id") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ap_approval_routing"
    ADD CONSTRAINT "ap_approval_routing_second_approver_id_fkey"
    FOREIGN KEY ("second_approver_id") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ap_approval_routing"
    ADD CONSTRAINT "ap_approval_routing_fallback_approver_id_fkey"
    FOREIGN KEY ("fallback_approver_id") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §1.6 — per-user notification prefs ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ap_notification_prefs" (
  "id"                             TEXT PRIMARY KEY,
  "user_id"                        TEXT NOT NULL,
  "notify_new_invoice"             BOOLEAN NOT NULL DEFAULT true,
  "notify_second_approval_request" BOOLEAN NOT NULL DEFAULT true,
  "notify_daily_digest"            BOOLEAN NOT NULL DEFAULT false,
  "notify_decision_outcome"        BOOLEAN NOT NULL DEFAULT false,
  "updated_at"                     TIMESTAMP(3) NOT NULL,
  "updated_by"                     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "ap_notification_prefs_user_id_key"
  ON "ap_notification_prefs" ("user_id");

DO $$ BEGIN
  ALTER TABLE "ap_notification_prefs"
    ADD CONSTRAINT "ap_notification_prefs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §1.5 — escalation columns on ap_requests ────────────────────────────────
-- Escalation is ADDITIVE, not a transfer: the routed peer stays able to sign.
-- `escalated_at IS NULL` is the scanner's idempotency key.
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "escalated_at" TIMESTAMP(3);
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "escalated_to" TEXT;

DO $$ BEGIN
  ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_escalated_to_fkey"
    FOREIGN KEY ("escalated_to") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Scanner reads: open second-approval requests that have not yet escalated.
CREATE INDEX IF NOT EXISTS "ap_requests_pending_second_escalation_idx"
  ON "ap_requests" ("status", "first_approved_at")
  WHERE "escalated_at" IS NULL;

-- ── Seeds (§1.4 + §1.6, exactly as tabulated) ───────────────────────────────
-- Matched on EMAIL, deliberately — NOT on name.
--
-- ⚠ NAME MATCHING IS UNSAFE HERE and a name-keyed first draft of this seed was
-- caught doing the wrong thing. Bill, Janette and Morena each have TWO live rows:
-- their manager/admin account (with an @svdp.us address) and an OPERATOR PIN
-- account created 2026-07-28 for the iPad floor rollout, which has NO email at all.
-- A `name`-keyed seed taking the newest row selects the operator account — a role
-- that cannot reach the AP queue and has no address to notify. The routing table
-- would have looked correctly populated while resolving to an EMPTY recipient set:
-- the exact defect this ADR exists to fix, reintroduced by its own seed.
--
-- Emails are unique per person and belong only to the manager/admin accounts, so
-- keying on them removes the ambiguity entirely. The role guard is belt-and-braces.
--
-- No-op on a clean CI replay (empty users table); idempotent on re-run.
-- prisma/seed.mjs carries the same pairs.
--
-- Routing (§1.4):  Janette→Morena · Morena→Janette · Kelsey→Morena
--                  Rick→Shannon   · Shannon→Rick   · Bill→Morena
INSERT INTO "ap_approval_routing"
  ("id", "first_approver_id", "second_approver_id", "fallback_approver_id",
   "fallback_after_hours", "active", "created_at", "updated_at", "updated_by")
SELECT gen_random_uuid()::text, f."id", s."id", NULL, 24, true,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'system:adr-0066-seed'
FROM (VALUES
  ('janette.tomas@svdp.us',    'morena.gomez@svdp.us'),
  ('morena.gomez@svdp.us',     'janette.tomas@svdp.us'),
  ('kelsey.ruhland@svdp.us',   'morena.gomez@svdp.us'),
  ('rick.albritton@svdp.us',   'shannon.rockwell@svdp.us'),
  ('shannon.rockwell@svdp.us', 'rick.albritton@svdp.us'),
  ('bill.barnard@svdp.us',     'morena.gomez@svdp.us')
) AS v(first_email, second_email)
JOIN "users" f ON lower(f."email") = v.first_email
              AND f."deleted_at" IS NULL AND f."role" IN ('manager', 'admin')
JOIN "users" s ON lower(s."email") = v.second_email
              AND s."deleted_at" IS NULL AND s."role" IN ('manager', 'admin')
ON CONFLICT ("first_approver_id") DO NOTHING;

-- Prefs (§1.6). Shannon: new_invoice FALSE — her net effect is exactly one kind of
-- email, a second-approval request on Rick's first signature, and nothing else ever.
-- Bill: new_invoice FALSE (he does not work the daily queue), digest TRUE.
-- decision_outcome is FALSE for everyone — ships as a column for future flexibility.
INSERT INTO "ap_notification_prefs"
  ("id", "user_id", "notify_new_invoice", "notify_second_approval_request",
   "notify_daily_digest", "notify_decision_outcome", "updated_at", "updated_by")
SELECT gen_random_uuid()::text, u."id", v.new_invoice, v.second_approval,
       v.digest, false, CURRENT_TIMESTAMP, 'system:adr-0066-seed'
-- Email-keyed for the same reason as the routing seed above: a name match would
-- attach prefs to the email-less operator PIN accounts.
FROM (VALUES
  ('morena.gomez@svdp.us',     true,  true, false),
  ('janette.tomas@svdp.us',    true,  true, false),
  ('rick.albritton@svdp.us',   true,  true, false),
  ('kelsey.ruhland@svdp.us',   true,  true, false),
  ('shannon.rockwell@svdp.us', false, true, false),
  ('bill.barnard@svdp.us',     false, true, true)
) AS v(email, new_invoice, second_approval, digest)
JOIN "users" u ON lower(u."email") = v.email
              AND u."deleted_at" IS NULL AND u."role" IN ('manager', 'admin')
ON CONFLICT ("user_id") DO NOTHING;
