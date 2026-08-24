-- ADR-0085 Amendment 1 — teach the three floor CHECK constraints the new
-- `floor_illegal` label. Runs AFTER 20260856_adr0085am1_floor_illegal_kind so
-- the label already exists and is committed (see that file's header for the
-- one-transaction-per-migration constraint that forces the split).
--
-- DROP + re-ADD rather than ALTER: Postgres has no ALTER CONSTRAINT for CHECK
-- expressions. The three predicates are copied verbatim from
-- 20260838a_adr0085_ipad_dropoff with `floor_illegal` added to each kind list;
-- the guarantees are unchanged in kind:
--
-- 1. `floor_no_money_or_pii` — a floor row's money and identity columns are all
--    NULL, `floor_illegal` included. The $3/unit Bye-Bye-Mattress claim on
--    illegally dumped units remains a manager-entered `illegal` row.
-- 2. `floor_requires_photo` — no floor drop-off without a photo, this kind too.
-- 3. `non_floor_requires_person` — the exemption widens to the three floor
--    kinds; manager-entered incentive/unpaid/illegal rows still require a name.
--
-- The window between DROP and ADD is inside this migration's transaction, so no
-- unguarded write can land in between.

ALTER TABLE "consumer_dropoffs" DROP CONSTRAINT "consumer_dropoffs_floor_no_money_or_pii";
ALTER TABLE "consumer_dropoffs"
  ADD CONSTRAINT "consumer_dropoffs_floor_no_money_or_pii" CHECK (
    "kind"::text NOT IN ('floor_public', 'floor_incentive', 'floor_illegal')
    OR (
      "incentive_cents"        IS NULL
      AND "incentive_amount_cents" IS NULL
      AND "person_name"        IS NULL
      AND "consumer_name"      IS NULL
      AND "check_number"       IS NULL
      AND "paid_at"            IS NULL
    )
  );

ALTER TABLE "consumer_dropoffs" DROP CONSTRAINT "consumer_dropoffs_floor_requires_photo";
ALTER TABLE "consumer_dropoffs"
  ADD CONSTRAINT "consumer_dropoffs_floor_requires_photo" CHECK (
    "kind"::text NOT IN ('floor_public', 'floor_incentive', 'floor_illegal')
    OR "photo_storage_key" IS NOT NULL
  );

ALTER TABLE "consumer_dropoffs" DROP CONSTRAINT "consumer_dropoffs_non_floor_requires_person";
ALTER TABLE "consumer_dropoffs"
  ADD CONSTRAINT "consumer_dropoffs_non_floor_requires_person" CHECK (
    "kind"::text IN ('floor_public', 'floor_incentive', 'floor_illegal')
    OR "person_name" IS NOT NULL
  );
