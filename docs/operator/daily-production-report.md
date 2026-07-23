# Operator Runbook — Daily Production Report

**ADR:** ADR-0030
**Sprint:** Sprint 5 (2026-06-17)

## What changed

A new automated email fires at the configured time (default 6 PM Pacific) for each site whose config row is enabled. Woodland and Eugene are both seeded enabled with the requested recipients. The email replaces Morena's manual daily report (Woodland) and provides equivalent visibility for Eugene.

**Recipients (seeded):**

- **Woodland:** `bill.barnard@svdp.us`, `bethany.cartledge@svdp.us`, `morena.gomez@svdp.us`
- **Eugene:** `shannon.rockwell@svdp.us`, `bill.barnard@svdp.us`, `bethany.cartledge@svdp.us`, `rick.albritton@svdp.us`

**Branding:** the email uses the SVdP (parent-org) palette from svdp.us — red `#a3151a` masthead with the white SVdP wordmark, gold/cream accents (this intentionally differs from the DR3 green/black in-app brand). Masthead title is `{Site} Daily Production Report`; subject is `DR3 Daily Production Report — {site} — {date}`.

**Numbers:** per-line units and the bonus dollars are computed on the **same floored basis as the signed payroll PDF** (`calculateDailyBonusCents`), so the report reconciles exactly with the PDF and "today" always reconciles with the month-to-date figure. The "Pace vs. last month" line compares month-to-date against the prior month's same-day window (clamped on month-end) — informational on mismatched-length months; the absolute unit totals are authoritative.

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

**From the host (no browser session needed)** — the loopback-only internal route renders the production-identical email and sends it to any single address, with an optional `date` to preview a past (populated) day:

```
docker exec dr3-vision-app node -e '
  const t = process.env.INTERNAL_CRON_TOKEN;
  fetch("http://127.0.0.1:3000/api/internal/bonus/daily-report/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
    body: JSON.stringify({ siteCode: "woodland", to: "bill.barnard@svdp.us", date: "2026-06-16" }),
  }).then(async r => console.log(r.status, await r.text()));
'
```

`date` is optional (defaults to today, Pacific). The route is guarded against the public Cloudflare tunnel (any request with a `cf-connecting-ip` header gets a 404) and writes no log row. A back-dated day with no active bonus rule returns `422 build_failed` rather than erroring.

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

## End-of-Day Inventory section (ADR-0037 Phase 4)

Every production email carries a per-site **End-of-Day Inventory** block below the
Trend block. The numbers come from the ONE running balance (`onHand`) the manager
surface uses — the email and the app can never disagree.

**Healthy state** (a `measured` physical count within the freshness window):

```
End-of-Day Inventory — Woodland
Program units on hand:        3,748
Non-program units on hand:      229
Total on hand:                3,977
Change from yesterday:         -142 (net outbound)
Program / non-program split:  94.2% / 5.8%
Latest physical count:        Jul 22, 2026 (today)
Counter:                      Morena
```

**Stale state** — this is what you will see until a floor count is recorded, and
it is deliberate. No on-hand figures are shown, because a computed balance drifts
between counts and a drifted number read as fact is how a month gets mis-billed:

```
⚠ Inventory pending physical count
Last measured anchor:  Jun 30, 2026 (22 days ago)
Computed balance is drift-prone; verify with a floor count.
```

To clear it: record a physical count (Manager → Inventory → Physical count) with
BOTH pools entered (program + non-program must sum to the counted total). A count
entered without the split is stored as `legacy` and still reads as stale — the
billing-relevant split is what makes the balance trustworthy.

**Zero state** — a site with no count and no activity yet (pre-backfill) shows
"No inventory activity recorded yet — awaiting the first physical count and daily
entries." That is normal before the workbook backfill lands; it is not an error.

**Missing section.** If the block is absent entirely, the inventory read failed;
the production numbers still went out by design. Check the app log for
`[daily-report] EOD inventory unavailable`.

### Freshness window

`EOD_INVENTORY_STALE_DAYS` (app environment, integer > 0, **default 14**) sets how
many days a physical count stays trusted. Change it in the app's compose env and
recreate the container:

```bash
ssh -F ~/noc-master/config/swarm-auto-update.sshconfig chad-hq
cd ~/DR3-Vision
# set EOD_INVENTORY_STALE_DAYS in the app env, then:
docker compose up -d --no-deps app
```

A missing/blank/zero/negative/non-integer value silently falls back to 14 — the
window can never be widened by a malformed env.

## Known limitations

- Patrick Dills shows in the Eugene email like any other processor (he's a Lead processor too — separation-of-duties carve-out only applies to the amendment workflow, not to production reporting).
- The Eugene comparison block will read "no previous data available" for same-day-last-year and prior-month same-period until enough Eugene history accrues (first full month: roughly mid-July 2026; first full year: June 2027).
- The daemon does not retry a failed M365 Graph send. Failed sends are logged and the next day's fire is independent. Use the manual re-send path above for critical missed days.
- End-of-Day Inventory attributes an iPad-captured load arriving after 5 PM Pacific to the NEXT day's report (the day bound is the report day's last UTC millisecond, which keeps backfilled reports from pulling in the following day's paperwork). No unit is lost — it lands one day later. Paper-bulk inbound entries, daily closes, outbound and landfilled rows are date-keyed and always land on their own day.
- The "Pace vs. last month" comparison clamps the prior month's end date to that month's last day (Mar 31 → Feb 28). On months with mismatched lengths the percentage is informational only; the absolute totals are the trustworthy numbers.
