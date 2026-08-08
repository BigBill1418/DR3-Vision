-- ADR-0082 — the open-dock-load measurement, published so the number can be
-- re-run and argued with rather than quoted on trust.
--
-- Run:
--   ssh 10.99.0.2 'docker exec -i dr3-vision-postgres psql -U dr3 -d dr3_vision' \
--     < docs/queries/2026-08-08-open-dock-loads.sql
--
-- ── READ THIS BEFORE QUOTING THE NUMBER ──────────────────────────────────────
--
-- "Open" here means `status IN (arrived, weight_captured, unload_started,
-- in_progress, finished)` on a `b2b_haul` row. That set is NOT the same as
-- "stranded", and the difference matters:
--
--   * A load at `in_progress` may be a truck being unloaded RIGHT NOW. The
--     status cannot distinguish "mid-unload" from "abandoned at lunch"; only
--     the AGE of the claim suggests it, which is why `days_before_today` is in
--     the output and why the summary counts it separately.
--   * `finished` is the unambiguous one: counted, not submitted, so its units
--     are measured and have not reached inventory or billing.
--   * The parent `expected_loads` row being cancelled does NOT close the child
--     load, and this query deliberately does not filter on it (ADR-0065 Am.1 —
--     filtering on a live parent is one of the three things that stranded loads
--     in the first place). `parent_cancelled` is REPORTED so the reader can see
--     whether any are in that state rather than having to assume.
--
-- Pacific conversion: `assigned_at` is `timestamp WITHOUT time zone` holding UTC
-- and the container's `TimeZone` is UTC, so the correct conversion is the DOUBLE
-- `AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles'`. A single
-- `AT TIME ZONE 'America/Los_Angeles'` INTERPRETS the naive value as Pacific and
-- converts it to UTC — the wrong direction, and it silently shifted a
-- 2026-07-28 19:55 UTC claim into "2026-07-29" on the first attempt at this
-- query.

-- ── Per-load detail ──────────────────────────────────────────────────────────
SELECT
  s.code                                   AS site,
  u.name                                   AS holder,
  il.status,
  ((il.assigned_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date
                                           AS claimed_pacific_day,
  ((now() AT TIME ZONE 'America/Los_Angeles')::date
   - ((il.assigned_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date)
                                           AS days_before_today,
  il.total_units,
  (el.cancelled_at IS NOT NULL)            AS parent_cancelled
FROM inbound_loads il
JOIN sites s              ON s.id  = il.site_id
LEFT JOIN users u         ON u.id  = il.assigned_operator_id
LEFT JOIN expected_loads el ON el.id = il.expected_load_id
WHERE il.load_source_type = 'b2b_haul'
  AND il.status IN ('arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished')
ORDER BY il.assigned_at;

-- ── Summary ──────────────────────────────────────────────────────────────────
-- `claimed_before_today` is the honest proxy for "cannot be an active unload":
-- a claim stamped on an earlier Pacific day is not a truck on the dock now.
SELECT
  count(*)                                             AS open_total,
  count(*) FILTER (
    WHERE ((il.assigned_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date
        < (now() AT TIME ZONE 'America/Los_Angeles')::date
  )                                                    AS claimed_before_today,
  count(*) FILTER (WHERE il.status = 'finished')       AS counted_not_submitted,
  sum(il.total_units) FILTER (WHERE il.status = 'finished')
                                                       AS units_counted_not_submitted,
  count(DISTINCT il.assigned_operator_id)              AS distinct_holders
FROM inbound_loads il
WHERE il.load_source_type = 'b2b_haul'
  AND il.status IN ('arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished');

-- ── The attribution tautology (ADR-0082 context) ─────────────────────────────
-- Expect closer_ne_claimer = 0 for every load submitted BEFORE ADR-0082: the
-- state machine made any other value impossible. A non-zero value after the
-- deploy is the feature working, not a defect.
SELECT
  count(*) FILTER (WHERE submitted_by_id IS NOT NULL)  AS closed,
  count(*) FILTER (
    WHERE submitted_by_id IS NOT NULL
      AND submitted_by_id <> assigned_operator_id
  )                                                    AS closer_ne_claimer
FROM inbound_loads
WHERE load_source_type = 'b2b_haul';
