# Compliance dashboard & alerting reference

This document defines exactly what DR3-Vision tracks, what fires when, and how alerts are routed.

## The seven metrics

Each metric appears as a tile on the manager Compliance dashboard (T-012 in Sprint 1). Tiles are color-coded green/yellow/red against the threshold. All values are per-site by default; cross-site rollup requires `admin` role.

### 1. MyMRC submission timeliness
- **What:** percentage of inbound loads submitted to MyMRC within 3 business days of receipt
- **Target:** ≥95%
- **Penalty:** 10% payment withhold per Exhibit H §3
- **Calculation:** `loads_submitted_within_3_days / total_loads_in_period`
- **Period:** 30-day rolling window, displayed both as 30-day and current-month
- **Click-through:** filtered load list of late submissions

### 2. Processed-units submission
- **What:** percentage of processed-unit batches submitted to MyMRC within 1 business day of processing
- **Target:** ≥95%
- **Penalty:** 10% payment withhold
- **Calculation:** `processing_sessions_submitted_within_1_day / total_sessions_in_period`
- **MVP note:** until V2.1 (Processor Form workflow) ships, this metric has no data source. Display as "Pending V2.1" in MVP.

### 3. Dock-appointment SLA
- **What:** percentage of loads where time from `scheduled_appointment_at` to `arrived_at` to start-of-unload is within 60 minutes
- **Target:** ≥90%
- **Penalty:** demurrage chargebacks per Article 11.3
- **Calculation:** `loads_with_unload_start_within_60_min / total_loads`
- **Click-through:** filtered list of late starts

### 4. Recycling rate
- **What:** percentage by weight of incoming material that is diverted from landfill
- **Target:** California ≥75%, Oregon ≥70%
- **Penalty:** 10% payment withhold; chronic failure is termination grounds
- **Calculation:** `(weight_recycled_lbs / weight_received_lbs)` over the rolling 12-month period
- **MVP note:** depends on V2.1 processed-units data; in MVP, display the most recent monthly value pulled from MyMRC reconciliation
- **Click-through:** breakdown by material category

### 5. In/out weight reconciliation
- **What:** how closely incoming weight matches outgoing weight (recycled + waste + leftover inventory)
- **Target:** ≥97% match within tolerance
- **Penalty:** flagged in MRC audit
- **Calculation:** `1 - abs(weight_in - (weight_recycled + weight_waste + weight_inventory)) / weight_in`
- **Click-through:** discrepancy list

### 6. Storage inventory
- **What:** current units on-site
- **Target:** within site limit
  - **California (Woodland):** 3,500 inside + 5,000 outside (separate counters)
  - **Oregon (Eugene):** 6,000 total on-site (off-site prohibited)
- **Penalty:** termination grounds (CA Article 6.5–6.6, OR Article 3.5)
- **Calculation:** rolling sum of (received - processed - shipped)
- **Critical alerting:** at 90% capacity, ntfy fires to Bill via `dr3-vision-container`

### 7. Records retention status
- **What:** are all required records (load records, photos, weight tickets, BOLs) still available within the retention window?
- **Target:** 100% — every record within the window must be retrievable
- **Penalty:** flagged in audit
- **Calculation:** count of records past the retention threshold but not yet purged (should be zero) + count of records inside the window with missing components (should be zero)
- **Window:** California 4 years, Oregon 5 years
- **Click-through:** detailed list of any flagged records

## Alert routing matrix

The single most-important rule about alerting: **ntfy push notifications go to Bill Barnard ONLY**, and only for two event categories. Everything else is in-app.

### ntfy (push to phone)

Reserved for system-level events that require Bill's immediate attention.

| Topic | What fires it | Recipient |
|---|---|---|
| `dr3-vision-system` | App outage, database unreachable, MyMRC scrape failures (after retries), R2 outage, observability failures | Bill only |
| `dr3-vision-container` | Storage capacity at 90%, container offline, container restart loop, healthcheck failures | Bill only |

These are the **only** two ntfy topics the application emits. Period.

**Delivery resilience (ADR-0025, 2026-06-09):** `publishNtfy` retries each path with
backoff (primary up to 3 attempts, fallback up to 2) under a 12 s total budget, so a
momentary network blip can't silently drop a payroll-deadline or system page. This
changes only *delivery reliability* — the routing matrix above (what fires, to whom)
is unchanged.

### In-app dashboard signals (no push)

All operational events. These appear on the manager portal and Compliance dashboard but never trigger phone notifications.

| Event | Where it shows | Who sees it |
|---|---|---|
| Load rejection | Load list (red status), Compliance dashboard rejection tile | Site managers, Morena, Kelsey |
| Long unload (> 60 min) | Live dock view (red tile), Compliance dashboard | Site managers, Morena, Kelsey |
| Dock SLA breach (> 60 min from appointment) | Compliance dashboard tile #3 | Site managers, Morena, Kelsey |
| Concern raised on a load | Load detail (yellow indicator), Compliance dashboard concerns tile | Site managers, Morena, Kelsey |
| PIN lockout | User management page (warning indicator), Compliance dashboard repeat-lockout indicator | Site managers, admins |
| Missed MyMRC submission deadline | Compliance dashboard tile #1 | Site managers, Morena, Kelsey, admins |
| Missed processed-units deadline | Compliance dashboard tile #2 | Site managers (V2.1+) |
| Storage at 80% (warning) | Compliance dashboard tile #6 (yellow) | Site managers, Morena, Kelsey |
| Recycling rate below threshold (warning) | Compliance dashboard tile #4 (yellow at 5% above threshold, red at threshold) | Site managers, Morena, Kelsey |
| Reconciliation discrepancy | Reconciliation page | Kelsey, Morena, admins |

### Why this matrix matters

A previous draft of the project routed all operational events to ntfy. The result: Bill was buried in noise, real system alerts got lost, and managers stopped checking the dashboard because everything came through Bill. The current matrix is the correction:

- **Bill is woken up** only for things only he can fix (system issues, capacity breaches)
- **Managers monitor the dashboard** during business hours (Morena, Kelsey, Rick, Janette)
- **Operational events resolve themselves** in normal business flow (rejections get reviewed, SLAs get analyzed, concerns get triaged)

Do not add new ntfy topics without an ADR superseding this routing.

## Email digests (optional, future)

Not in Sprint 1. Future possibility: a daily/weekly digest emailed to managers summarizing dashboard tiles. Scope this when V2.1 lands.

## References

- ADR-0007 (audit log)
- ADR-0006 (offline queue surfaces queue-health on dashboard)
- Charter §4.6 (Compliance dashboard), §5.7 (Alert routing)
- Q16 in charter v0.21 changelog (alert routing locked in)
