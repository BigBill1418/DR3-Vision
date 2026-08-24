-- ADR-0085 Amendment 1 — the third label-only drop-off kind for the iPad
-- walk-up flow: Illegal. Requested by the floor team 2026-08-24; sits between
-- Public and Incentive on the capture screen.
--
-- SPLIT FROM THE CONSTRAINT REWRITE ON PURPOSE, same as the original pair
-- (20260838 / 20260838a): Postgres allows `ALTER TYPE ... ADD VALUE` inside a
-- transaction block from 12 onward, but the newly added label CANNOT BE USED in
-- that same transaction. Prisma runs each migration.sql in one transaction, so
-- the CHECK constraints in `20260856a_adr0085am1_floor_illegal_constraints` —
-- which name this label — must land in a LATER transaction than the one that
-- creates it.
--
-- WHY A NEW LABEL rather than reusing `illegal` from the floor: the manager
-- `illegal` kind requires a `person_name` (`non_floor_requires_person`) and
-- mints units × 300¢ of Bye-Bye-Mattress check money by default
-- (`mintsCheckMoneyByDefault` in service.ts). The floor flow, by Bill's
-- explicit 2026-08-07 call, carries no money and no PII — the label is the
-- thing that keeps both off, exactly as it is for `floor_incentive`.

ALTER TYPE "ConsumerDropoffKind" ADD VALUE IF NOT EXISTS 'floor_illegal';
