-- ADR-0046 Amendment 3 — AP go-live features (operator-directed 2026-07-09).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds ONE enum value (`pending_review`) to ApRequestStatus and THREE
-- nullable columns to ap_requests (the hold / "pending review" record). No
-- existing table is dropped/altered destructively; no data statement uses the new
-- enum value in THIS transaction, so the Postgres "unsafe use of new enum value"
-- rule never applies (mirrors 20260709_alert_recipients, which adds enum values
-- the same way and clean-replays).
--
-- The dir name `20260716_ap_hold_and_notes` sorts AFTER the current main chain tip
-- (`20260715b_rollup_ap_boardpack_yard`) and BEFORE the sibling ADR-0049 build's
-- `20260716b_*`, preserving ADR-0035 lexical migration ordering.

-- AlterEnum: hold status (used only in later migrations / at runtime, never here).
ALTER TYPE "ApRequestStatus" ADD VALUE 'pending_review';

-- AlterTable: the hold record on a request (held_by is a bare audit-actor user id,
-- matching decided_by — no FK, per the AP audit-column convention).
ALTER TABLE "ap_requests" ADD COLUMN "held_by" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN "held_at" TIMESTAMP(3);
ALTER TABLE "ap_requests" ADD COLUMN "hold_note" TEXT;
