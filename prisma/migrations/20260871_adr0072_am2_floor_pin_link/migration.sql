-- ADR-0072 Amendment 2 (2026-11-06) — link a manager account to the SAME person's
-- operator account, so they can approve a held count on the iPad with the floor
-- PIN they already know.
--
-- Manager/admin accounts carry no `pin_hash` (ADR-0016: they sign in with Entra),
-- and `verifyPin` refuses any non-operator, so the on-device release path could not
-- succeed for anyone. Some people (Woodland: two site managers) hold BOTH an
-- operator account with a floor PIN and a manager account without one.
-- `floor_user_id` on the MANAGER row points at that person's operator row. The
-- PIN is verified against the operator row, where its lockout already lives.
--
-- One operator row backs at most one manager row (UNIQUE; Postgres lets any
-- number of rows hold NULL). An account cannot link to itself (CHECK). Deleting the
-- operator row clears the link rather than blocking the delete (ON DELETE SET NULL).
-- No row is written here: links are set per person by an admin with
-- `scripts/link-floor-pin.mjs`, never by migration.
--
-- ADDITIVE ONLY and CLEAN-REPLAY SAFE (ADR-0035): every statement is guarded.
-- ROLLBACK: ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_floor_user_id_not_self";
--           ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_floor_user_id_fkey";
--           DROP INDEX IF EXISTS "users_floor_user_id_key";
--           ALTER TABLE "users" DROP COLUMN IF EXISTS "floor_user_id";

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "floor_user_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_floor_user_id_key" ON "users"("floor_user_id");

DO $$ BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_floor_user_id_fkey"
    FOREIGN KEY ("floor_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_floor_user_id_not_self"
    CHECK ("floor_user_id" IS NULL OR "floor_user_id" <> "id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
