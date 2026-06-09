-- DR3-Vision — All-sites manager (ADR-0024)
-- Migration: 20260609_all_sites_manager
--
-- Adds the `all_sites` flag to users. When true, a `manager` reaches every
-- site like an admin would, but WITHOUT the admin role — so it confers none of
-- the admin-only powers (user management, bonus amendment/override, /admin).
-- This is the mechanism behind ADR-0024 (amends the CLAUDE.md hard-rule #2
-- "cross-site rollups require admin role" to also permit an explicitly-flagged
-- all-sites manager). Pure DDL; defaults false so every existing row is
-- unchanged.

ALTER TABLE "users"
  ADD COLUMN "all_sites" BOOLEAN NOT NULL DEFAULT false;
