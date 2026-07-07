-- ADR-0047 — staff-output rollout gate + ADR-0039 Amendment 1 leg-liveness gate.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds:
--   - one `AuditFindingCause` enum value (`bootstrap_suppression`) — used only at
--     RUNTIME by the auto-resolve seed step, never referenced in this migration,
--     so the Postgres "unsafe use of a freshly-added enum value in the same
--     transaction" rule never applies (same idiom as 20260709_alert_recipients);
--   - `audit_runs.suppressed_bootstrap` JSONB (per-check withheld-finding counts);
--   - two enums + two tables for the rollout gate:
--       * `rollout_surfaces` — every staff-facing surface (notification | ui) × site,
--         default `pilot` (admin-only) until an admin flips it `live` (audited).
--       * `audit_bootstrap_gates` — admin-editable per-(site, leg) go-live override.
--
-- FK columns on the two new tables are declared as PLAIN SCALARS in schema.prisma
-- (repo convention, mirrors ADR-0040) so the block never edits the shared
-- Site/User relation lists; the referential-integrity constraints are created
-- here at the DB level. `rollout_surfaces.flipped_by` is a bare audit-actor
-- column with NO FK (mirrors `alert_recipients.created_by`).
--
-- The dir name `20260713_rollout_gate` sorts AFTER the current main chain tip
-- (`20260712_ap_approvals`), preserving ADR-0035 lexical migration ordering.

-- ─────────────────────────────────────────────────────────────────────────
-- Enum extension — bootstrap-suppression cause (auto-resolve provenance)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TYPE "AuditFindingCause" ADD VALUE 'bootstrap_suppression';

-- ─────────────────────────────────────────────────────────────────────────
-- audit_runs.suppressed_bootstrap — per-check withheld-finding counts
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "audit_runs" ADD COLUMN "suppressed_bootstrap" JSONB;

-- ─────────────────────────────────────────────────────────────────────────
-- Rollout-gate enums
-- ─────────────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "RolloutSurfaceKind" AS ENUM ('notification', 'ui');

-- CreateEnum
CREATE TYPE "RolloutState" AS ENUM ('pilot', 'live');

-- ─────────────────────────────────────────────────────────────────────────
-- rollout_surfaces — the per-surface × per-site pilot/live registry (ADR-0047)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "rollout_surfaces" (
    "id" TEXT NOT NULL,
    "kind" "RolloutSurfaceKind" NOT NULL,
    "surface_code" TEXT NOT NULL,
    "site_id" TEXT,
    "rollout_state" "RolloutState" NOT NULL DEFAULT 'pilot',
    "flipped_by" TEXT,
    "flipped_at" TIMESTAMP(3),
    "criteria_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rollout_surfaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rollout_surfaces_surface_code_site_id_key" ON "rollout_surfaces"("surface_code", "site_id");
CREATE INDEX "rollout_surfaces_kind_idx" ON "rollout_surfaces"("kind");

ALTER TABLE "rollout_surfaces"
    ADD CONSTRAINT "rollout_surfaces_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- audit_bootstrap_gates — per-(site, leg) go-live override (ADR-0039 A1)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "audit_bootstrap_gates" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "go_live_date" DATE,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_bootstrap_gates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audit_bootstrap_gates_site_id_leg_key" ON "audit_bootstrap_gates"("site_id", "leg");

ALTER TABLE "audit_bootstrap_gates"
    ADD CONSTRAINT "audit_bootstrap_gates_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
