-- ADR-0037 D-3 — count-day boundary is timezone-broken (MAJOR, money-critical).
--
-- The manager physical-count API stamped the anchor at UTC-midnight
-- (`${countedAt}T00:00:00Z`). In Pacific that is 17:00 the PRIOR day (a "June 30
-- count" read as June 29 evening), and it made same-Pacific-day flow attribution
-- asymmetric: the count day's own @db.Date outflow (processed / outbound /
-- landfilled / drop-offs, all keyed at UTC-midnight) was dropped by `> anchor`,
-- while same-day inbound (`arrived_at`, a timestamptz > UTC-midnight) was included.
--
-- The fix (code): anchors are now stamped at Pacific-midnight (00:00 PT) of their
-- count day, and `anchorFlowBounds` derives Pacific-calendar-consistent flow
-- windows (running-balance.ts + leg-fetchers.ts). This migration corrects EXISTING
-- physical snapshots to match: a snapshot written by the old route sits at exactly
-- UTC-midnight; shift it to Pacific-midnight of the SAME calendar day.
--
-- Bill's hard rule: NEVER alter the counts. Only `snapshot_at` moves; every unit
-- and pool value (units_indoor / units_total / units_in_processing / program_units
-- / non_program_units / pool_attribution / reconciled_delta) is untouched. An
-- append-only audit_log row is written per corrected snapshot.
--
-- Idempotent: the guard matches only rows whose `snapshot_at` is exactly at
-- UTC-midnight (the old-route shape). After correction they sit at 07:00/08:00Z
-- (Pacific-midnight, DST-aware) and no longer match — a re-run is a clean no-op,
-- and so is a fresh CI database (no such rows exist).
--
-- PROD (2026-07-23): exactly two Woodland physical anchors — 2026-06-30 (June close
-- 3748/229/3977) and 2026-07-22 (live count 1597/886/2483); both at 00:00:00, both
-- corrected to 07:00:00Z (00:00 PDT). Counts confirmed unchanged.

-- 1. Append-only audit trail (before the shift, so `before` captures UTC-midnight).
INSERT INTO "audit_log" ("id", "actor_label", "action", "table_name", "row_id", "before", "after", "created_at")
SELECT
  gen_random_uuid()::text,
  'adr-0037-d3-countday-boundary',
  'update'::"AuditAction",
  'site_inventory_snapshots',
  s."id",
  jsonb_build_object(
    'snapshot_at', to_char(s."snapshot_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'note', 'counts unchanged — only snapshot_at shifted UTC-midnight -> Pacific-midnight'
  ),
  jsonb_build_object(
    'snapshot_at', to_char(
      (s."snapshot_at"::date::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  ),
  NOW()
FROM "site_inventory_snapshots" s
WHERE s."snapshot_kind" = 'physical'
  AND s."snapshot_at" = s."snapshot_at"::date::timestamp;

-- 2. Shift snapshot_at to Pacific-midnight of its own calendar day (DST-aware via
--    AT TIME ZONE). No count column is referenced, so no count can move.
UPDATE "site_inventory_snapshots" s
SET "snapshot_at" = (s."snapshot_at"::date::timestamp AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'
WHERE s."snapshot_kind" = 'physical'
  AND s."snapshot_at" = s."snapshot_at"::date::timestamp;
