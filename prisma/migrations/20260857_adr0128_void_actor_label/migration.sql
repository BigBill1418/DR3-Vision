-- ADR-0128 — a void records WHO decided it, not merely who was holding the load.
--
-- `voidLoad` took one `operatorUserId` and used it for two unrelated jobs: the
-- ownership check (may this caller void?) and the attribution (`voided_by`, and
-- the audit row's `actor_user_id`). So a void made on an operator's behalf —
-- by a script, by a manager, by ADR-0073 when it exists — signed itself with
-- that operator's name, and nothing in the row said otherwise.
--
-- That is not hypothetical. The 2026-08-25 Lake County correction voided the
-- duplicate load through the SHIPPED path, deliberately, to keep the transition
-- guard and the slot severing — and `inbound_loads.voided_by` now names Janette
-- Tomas for a decision Bill made and a script executed. A supplementary
-- `audit_log` row under `actor_label = 'system:bo-lake-county-repoint'` carries
-- the truth, but a reader of the load row alone still gets the wrong answer
-- (OPEN-ITEMS §0.BO, BO-6).
--
-- The repo already has the right shape for a non-user actor — `audit_log`'s
-- `actor_label`, and the 2026-08-06 terex one-offs' rule of "a label rather than
-- a borrowed users.id". This column is what lets the void path honour it.
--
-- NULLABLE and additive. Every existing voided row keeps its `voided_by` and
-- reads NULL here, which is true of them: measured on production 2026-08-25,
-- both voided rows carry a `voided_by`, and all 772 non-voided rows carry
-- neither column — so the CHECK below is already satisfied by every row in the
-- table and lands VALIDATED rather than NOT VALID. A constraint that skips the
-- rows that already exist protects nothing.

ALTER TABLE "inbound_loads"
  ADD COLUMN IF NOT EXISTS "voided_by_label" TEXT;

COMMENT ON COLUMN "inbound_loads"."voided_by_label" IS
  'ADR-0128 — a non-user void actor in the audit_log.actor_label shape (system:<slug>). Exactly one of voided_by / voided_by_label is set on a voided row.';

-- Stated as a constraint rather than left to the service, because `voidLoad` is
-- not the only thing that has ever written these columns — the August
-- hand-audited DB corrections wrote them directly, and the next one will too. A
-- row that says "voided" and names nobody is the defect this ADR closes; a row
-- that names two different actors is a new one.
ALTER TABLE "inbound_loads"
  DROP CONSTRAINT IF EXISTS "inbound_loads_void_actor_exactly_one";

ALTER TABLE "inbound_loads"
  ADD CONSTRAINT "inbound_loads_void_actor_exactly_one"
  CHECK (
    CASE
      WHEN "status" = 'voided'
        THEN ("voided_by" IS NOT NULL) <> ("voided_by_label" IS NOT NULL)
      ELSE "voided_by" IS NULL AND "voided_by_label" IS NULL
    END
  );
