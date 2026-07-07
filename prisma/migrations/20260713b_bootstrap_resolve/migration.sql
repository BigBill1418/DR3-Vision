-- ADR-0039 Amendment 1 / ADR-0047 — auto-resolve existing bootstrap findings.
--
-- One-shot, idempotent, DEPLOY-TIME (runs in the migrate init-container, which
-- does NOT run the seed). Resolves every OPEN/ACKNOWLEDGED missing-counterpart
-- finding whose leg has NEVER contained data for its site AND has no passed
-- admin `go_live_date` — i.e. exactly the findings the new leg-liveness gate
-- would now suppress (the 2026-07-06 incident: Eugene c4_billing_basis +
-- m2_missing_snapshot). Findings are RESOLVED with cause `bootstrap_suppression`
-- and a provenance note — NEVER deleted (the ledger stays honest).
--
-- Split from `20260713_rollout_gate` on purpose: that migration ADDS the
-- `bootstrap_suppression` enum value, and Postgres forbids using a freshly-added
-- enum value in the SAME transaction. This separate migration runs after that
-- one has committed, so the value is usable here.
--
-- CLEAN-REPLAY (ADR-0035): on an empty PG16 every UPDATE matches 0 rows — a
-- harmless no-op. IDEMPOTENT: a second apply finds nothing still open. A finding
-- on a leg that HAS data (or whose go_live_date has passed) is left OPEN — it is
-- a real discrepancy, not a bootstrap artifact.

-- c4_billing_basis → billing leg (P2 invoices)
UPDATE "audit_findings" f SET
    "status" = 'resolved',
    "cause_category" = 'bootstrap_suppression',
    "resolution_note" = 'Auto-resolved by ADR-0039 Amendment 1 leg-liveness bootstrap gating (ADR-0047): the billing leg for this site has never contained data (no P2 invoice) and has no passed go_live_date, so this missing-counterpart finding is a startup artifact, not a real discrepancy. Provenance retained; not deleted.',
    "resolved_at" = NOW(),
    "updated_at" = NOW()
WHERE f."status" IN ('open', 'acknowledged')
  AND f."check_code" = 'c4_billing_basis'
  AND NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."site_id" = f."site_id")
  AND NOT EXISTS (
    SELECT 1 FROM "audit_bootstrap_gates" g
    WHERE g."site_id" = f."site_id" AND g."leg" = 'billing'
      AND g."go_live_date" IS NOT NULL AND g."go_live_date" <= CURRENT_DATE
  );

-- m1_missing_close → close leg (daily processed-units close)
UPDATE "audit_findings" f SET
    "status" = 'resolved',
    "cause_category" = 'bootstrap_suppression',
    "resolution_note" = 'Auto-resolved by ADR-0039 Amendment 1 leg-liveness bootstrap gating (ADR-0047): the close leg for this site has never contained data (no processed-units close) and has no passed go_live_date, so this missing-counterpart finding is a startup artifact, not a real discrepancy. Provenance retained; not deleted.',
    "resolved_at" = NOW(),
    "updated_at" = NOW()
WHERE f."status" IN ('open', 'acknowledged')
  AND f."check_code" = 'm1_missing_close'
  AND NOT EXISTS (SELECT 1 FROM "processed_units_daily" p WHERE p."site_id" = f."site_id")
  AND NOT EXISTS (
    SELECT 1 FROM "audit_bootstrap_gates" g
    WHERE g."site_id" = f."site_id" AND g."leg" = 'close'
      AND g."go_live_date" IS NOT NULL AND g."go_live_date" <= CURRENT_DATE
  );

-- m2_missing_snapshot → snapshot leg (physical inventory count)
UPDATE "audit_findings" f SET
    "status" = 'resolved',
    "cause_category" = 'bootstrap_suppression',
    "resolution_note" = 'Auto-resolved by ADR-0039 Amendment 1 leg-liveness bootstrap gating (ADR-0047): the snapshot leg for this site has never contained a physical inventory count and has no passed go_live_date, so this missing-counterpart finding is a startup artifact, not a real discrepancy. Provenance retained; not deleted.',
    "resolved_at" = NOW(),
    "updated_at" = NOW()
WHERE f."status" IN ('open', 'acknowledged')
  AND f."check_code" = 'm2_missing_snapshot'
  AND NOT EXISTS (
    SELECT 1 FROM "site_inventory_snapshots" s
    WHERE s."site_id" = f."site_id" AND s."snapshot_kind" = 'physical'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "audit_bootstrap_gates" g
    WHERE g."site_id" = f."site_id" AND g."leg" = 'snapshot'
      AND g."go_live_date" IS NOT NULL AND g."go_live_date" <= CURRENT_DATE
  );
