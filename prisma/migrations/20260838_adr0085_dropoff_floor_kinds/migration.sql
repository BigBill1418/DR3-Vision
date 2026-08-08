-- ADR-0085 — the two label-only drop-off kinds for the iPad walk-up flow.
--
-- SPLIT FROM THE REST OF THE MIGRATION ON PURPOSE. Postgres allows
-- `ALTER TYPE ... ADD VALUE` inside a transaction block from 12 onward (prod is
-- 16.13), but the newly added label CANNOT BE USED in that same transaction.
-- Prisma runs each migration.sql in one transaction, so the CHECK constraints
-- in `20260838a_adr0085_ipad_dropoff` — which name these labels — must land in
-- a LATER transaction than the one that creates them.
--
-- The sibling migration compares `kind::text` rather than the enum label, which
-- would probably have been safe in a single file. "Probably safe" is not the bar
-- for a migration that only ever runs once, on production, unattended: a failure
-- here wedges the deploy at the schema step. Two directories cost one extra
-- folder and remove the question entirely.
--
-- WHY NEW LABELS AT ALL, rather than reusing `unpaid` for Public:
-- `src/lib/dropoffs/service.ts` defaults `incentive_amount_cents` to
-- units × 300¢ for EVERY kind that is not `incentive`. Reusing `unpaid` would
-- have minted $3/unit of Bye-Bye-Mattress check money on a flow Bill explicitly
-- said records none. The label is the thing that keeps the money off.

ALTER TYPE "ConsumerDropoffKind" ADD VALUE IF NOT EXISTS 'floor_public';
ALTER TYPE "ConsumerDropoffKind" ADD VALUE IF NOT EXISTS 'floor_incentive';
