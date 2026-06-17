# Operator Runbook — Daily Production Report

**ADR:** ADR-0030
**Sprint:** Sprint 5 (2026-06-17)

## What changed

A new automated email fires at the configured time (default 6 PM Pacific) for each site whose config row is enabled. Woodland and Eugene are both seeded enabled with the requested recipients. The email replaces Morena's manual daily report (Woodland) and provides equivalent visibility for Eugene.

## Deploy

```
git checkout main && git pull
docker compose up -d
```

This applies migration `20260617_daily_production_report` (additive — adds `is_super_admin` column on `users`, three new tables, no destructive changes), runs the seed, and starts `dr3-vision-bonus-daily-report`.

## Verify

1. Migration applied:

   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;"
   ```

   Expect: `20260617_daily_production_report`.

2. Configs seeded:

   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT s.code, c.enabled, c.send_time_pt FROM bonus_daily_report_config c JOIN sites s ON s.id = c.site_id ORDER BY s.code;"
   ```

   Expect two rows: eugene (enabled, 18:00) and woodland (enabled, 18:00).

3. Recipients seeded:

   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT s.code, r.email FROM bonus_daily_report_recipients r JOIN bonus_daily_report_config c ON c.id = r.config_id JOIN sites s ON s.id = c.site_id ORDER BY s.code, r.email;"
   ```

   Expect 3 Woodland rows + 4 Eugene rows.

4. Bill flagged super-admin:

   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT email, role, is_super_admin FROM users WHERE is_super_admin = true;"
   ```

   Expect exactly one row: `bill.barnard@svdp.us | admin | t`.

5. Daemon alive:

   ```
   docker logs dr3-vision-bonus-daily-report --tail 30
   ```

   Expect `daemon starting` followed by `sleeping until ...`.

6. Admin tile accessible to Bill at `/admin/production-report`. Both site cards visible. Edits round-trip and write audit rows.

## Test fire (without waiting until 6 PM)

From the admin tile, click "Send test now" on either site card. The email lands in your own inbox (not the configured recipient list) with subject prefixed `[TEST]`. No `bonus_daily_report_log` row is created, so the scheduled 6 PM send still fires normally.

## Force a re-send of today's production email

If the scheduled send failed and the issue is fixed:

```
docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "DELETE FROM bonus_daily_report_log WHERE site_id = (SELECT id FROM sites WHERE code = 'woodland') AND report_date = CURRENT_DATE;"
docker restart dr3-vision-bonus-daily-report
```

The daemon sleeps until the next configured fire instant. **There is no in-band "fire now" for the production send** — by design. For a same-day recovery before 6 PM, this is fine. After 6 PM, edit the config to a near-future send time (e.g. 18:30 PT), save, and the daemon will pick it up at the next iteration.

## Changing recipients

`/admin/production-report` → Add/remove via chips → Save. Every change is audit-tracked. Effective on the next fire (no daemon restart needed).

## Rollback

```
docker compose down dr3-vision-bonus-daily-report
docker compose up -d --no-deps app
```

The migration is additive — tables can stay. Drop cleanly only if needed:

```sql
DROP TABLE bonus_daily_report_log;
DROP TABLE bonus_daily_report_recipients;
DROP TABLE bonus_daily_report_config;
ALTER TABLE users DROP COLUMN is_super_admin;
```

## Known limitations

- Patrick Dills shows in the Eugene email like any other processor (he's a Lead processor too — separation-of-duties carve-out only applies to the amendment workflow, not to production reporting).
- The Eugene comparison block will read "no previous data available" for same-day-last-year and prior-month same-period until enough Eugene history accrues (first full month: roughly mid-July 2026; first full year: June 2027).
- The daemon does not retry a failed M365 Graph send. Failed sends are logged and the next day's fire is independent. Use the manual re-send path above for critical missed days.
- The "Pace vs. last month" comparison clamps the prior month's end date to that month's last day (Mar 31 → Feb 28). On months with mismatched lengths the percentage is informational only; the absolute totals are the trustworthy numbers.
