-- 2026-07-20 (operator-directed, Bill) — ADR-0046 amendment: third location
-- disposition "NOT DR3 — See Reason" on the AP approval portal.
--
-- Today an AP decision must tag a real DR3 site (Woodland/Eugene). This adds a
-- third choice for an invoice that is NOT for a DR3 location at all (mis-addressed,
-- wrong entity, a parent-org bill, etc.): the approver marks it NOT DR3 and supplies
-- a reason. Such a decision is NOT filed against a real site's books — site_id stays
-- NULL and filed_not_dr3 is set true.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay). Sorts AFTER the latest existing migration
-- (20260727_adr0041_pilot_mode_gp_export). Default false ⇒ every pre-existing row
-- backfills safely as a normal site-filed decision; no data migration needed.
ALTER TABLE "ap_requests" ADD COLUMN "filed_not_dr3" BOOLEAN NOT NULL DEFAULT false;

-- Invariant, "never both" half, enforced at the DB (defense in depth; the
-- application layer in decideRequest enforces the full exactly-one rule): a row can
-- never be BOTH site-filed and marked NOT DR3. This is a PARTIAL check by design —
-- it deliberately does NOT require "never neither", so historical rows decided
-- before the site-required directive (site_id NULL, filed_not_dr3 false) remain
-- valid and are not rejected on replay/backfill.
ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_location_exclusive_chk"
    CHECK (NOT ("filed_not_dr3" = true AND "site_id" IS NOT NULL));
