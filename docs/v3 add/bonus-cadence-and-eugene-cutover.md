# Bonus cadence + Eugene cutover — operator runbook

Companion to ADR-0019.1 and ADR-0019.2. This runbook covers the Monday Jun 8, 2026 cutover: bi-weekly cadence goes live and Eugene becomes a second bonus site.

**Who does this:** Bill, with optional pairing if a SVdP M365 admin is needed.

**When:** Sun Jun 7 EOD (deploy + verify) and Mon Jun 8 17:30 PT onward (first close cycle).

---

## Pre-cutover decision: Period 12 disposition

Period 12 of 2026 spans Tue May 26 → Mon Jun 8. The bonus surface was shipped to production on Sat Jun 6, and no production daily entries exist yet. The first close cron fires Mon Jun 8 17:30 PT — against Period 12.

Three options. Pick one before the deploy and document the choice:

**Option 1 (DEFAULT): Skip Period 12.** Manually transition Period 12 to `skipped` state at deploy time via a one-off admin action. No PDF generated for Period 12. Period 13 (Tue Jun 9 → Mon Jun 22) is the first canonical bi-weekly payroll PDF, with pay date Fri Jun 26.

SQL to skip Period 12 at deploy:

```sql
UPDATE bonus_pay_periods
SET state = 'skipped'
WHERE period_year = 2026
  AND period_number = 12;
-- 2 rows updated (Woodland + Eugene)
```

**Option 2: Backdate Period 12.** Use the admin-only `AdminDatePicker` (shipped 2026-06-06) to fill in Janette's and Rick's recollection of daily counts for May 26 – Jun 8. Period 12 then closes Mon Jun 8 17:30 PT with the recollected data and pays out on Fri Jun 12 like a normal period.

**Option 3: Manual partial Period 12.** Janette + Rick enter what they can; the system flags partial in the PDF. Not recommended — adds payroll-side ambiguity.

Document the choice in the deploy log.

---

## Pre-cutover step 1: Eugene roster bootstrap

Two paths to get Eugene processors into the system:

**Path A (preferred): Bill provides CSV.** Drop a CSV at `prisma/seed/bonus_employees_eugene.csv` with columns `site_code,full_name,is_active,notes`. The deploy seed step picks it up automatically. Use this if you have the Eugene processor list available before the deploy.

**Path B: Rick adds in-app on Mon Jun 8 morning.** Rick signs in, navigates to `/bonus/employees`, adds each processor by name. ~30 seconds per processor; ~5-15 minutes total for typical Eugene roster size.

Path A is preferred because it gets the roster in place before the cutover, which means daily entries can start Mon Jun 8 immediately. Path B works fine if A isn't feasible.

---

## Pre-cutover step 2: Verify Entra account states

Critical for the auto-override path. Verify in Entra admin center that the following accounts are **active and not locked**:

- `bill.barnard@svdp.us` (Bill, admin, universal auto-override actor)
- `kelsey.ruhland@svdp.us` (Kelsey, admin, Eugene ops signer + Bill backup for Eugene)
- `morena.gomez@svdp.us` (Morena, manager, Woodland ops signer + backup override for Janette)
- `janette.thomas@svdp.us` (Janette, manager, Woodland facility signer)
- `rick.albritton@svdp.us` (Rick, manager, Eugene facility signer)

If any account is missing or locked, fix it before deploy. The signature chain seed references these users by email; deploy will fail if a referenced user can't be found.

---

## Deploy steps

SSH to CHAD-HQ:

```bash
ssh chad-hq
cd /opt/dr3-vision
```

Pull the sprint-2-addendum branch into main:

```bash
git fetch origin
git checkout main
git merge --ff-only origin/sprint-2-addendum
git log --oneline -5  # verify the addendum commits are at the tip
```

If swarmpilot_deployer is up and configured, it auto-deploys. If not (or if you want explicit control), trigger manually:

```bash
docker compose pull  # no-op if local build only
docker compose build app
docker compose up -d --force-recreate --no-deps app migrate
```

Watch the migrate container apply the new migration:

```bash
docker compose logs -f migrate | head -50
```

Expect:

```
Applying migration `20260606_bi_weekly_pay_periods`
...
Database schema is up to date.
[ntfy] Migration applied: 20260606_bi_weekly_pay_periods
```

Then the seed step runs (depending on your seed strategy — `prisma db seed` or app-bootup seed call):

```bash
docker compose exec app npm run db:seed  # if seed is a separate step
```

Expect:

```
Seeding bonus_pay_periods... 52 rows upserted (26 per site × 2 sites)
Seeding bonus_signature_chains... 2 rows upserted
Applying post-seed DDL (NOT NULL + unique index)... done
```

If using Option 1 for Period 12 (skip), run the skip SQL now:

```bash
docker compose exec postgres psql -U postgres -d dr3_vision -c "
UPDATE bonus_pay_periods
SET state = 'skipped'
WHERE period_year = 2026 AND period_number = 12;"
```

Recreate the bonus cron containers so they pick up the new period-close + escalation scripts:

```bash
docker compose up -d --force-recreate --no-deps bonus-period-close bonus-escalation
```

(Adjust service names to match the compose file.)

---

## Verification — Sun Jun 7 EOD

```bash
# 1. Migration applied
docker compose exec app npx prisma migrate status
# Expect: "Database schema is up to date!"

# 2. Pay periods seeded
docker compose exec postgres psql -U postgres -d dr3_vision -c "
SELECT site_id, COUNT(*) FROM bonus_pay_periods GROUP BY site_id;"
# Expect: 26 per site_id (two rows total in the result)

# 3. Signature chains seeded
docker compose exec postgres psql -U postgres -d dr3_vision -c "
SELECT s.code, sc.facility_signer_user_id, sc.ops_signer_user_id, sc.auto_override_actor_user_id
FROM bonus_signature_chains sc
JOIN sites s ON s.id = sc.site_id;"
# Expect: two rows, one per site, with the configured user IDs

# 4. Cron services running
docker compose ps bonus-period-close bonus-escalation bonus-eod-check
# Expect: all three "Up"

# 5. Healthz includes Pacific date
curl -s https://dr3-vision.svdp.us/healthz | jq .pacific_today
# Expect: "2026-06-07"

# 6. Tile visibility per role (manual browser check)
# - Sign in as Bill → Vision Dashboard should show Bonus Management tile
# - Click → site picker should render with Woodland + Eugene options
# - Sign in as Rick → Vision Dashboard should show Bonus Management tile
# - Click → should route to /bonus?site=eugene (no picker)
```

---

## Day-of — Mon Jun 8

**17:00 PT:** EOD ntfy fires if any active employee at either site has no entry for today.

**17:30 PT:** Period-close cron fires. Verify in cron logs:

```bash
docker compose logs --tail 200 bonus-period-close
# Expect: "Closing Period 12 of 2026 for site=woodland..." (if not Option 1)
#         "Signature-request email queued to janette@svdp.us"
#         Same for Eugene if not Option 1
```

If Option 1 (skipped), the cron finds no draft periods with `period_end = 2026-06-08` and logs "No periods to close."

**18:00 PT (recommended):** Janette and Rick sign their facility slots if they're still on-shift. Note: if Option 1 chosen, this step is skipped.

---

## Day-of — Tue Jun 9 (only relevant if not Option 1)

**06:00 PT:** Low-urgency ntfy to Bill if any slot still unsigned. Check phone.

**07:30 PT:** Urgent ntfy. Bill, Morena (for Woodland), and Kelsey (for Eugene) all get pinged. Time for one of them to sign manually.

**08:30 PT:** Auto-override fires for any still-unsigned slot. Bill's account signs as the universal auto-override actor.

**08:30 – 09:00 PT:** PDF generation + Microsoft Graph sendMail. Check `payroll@svdp.us` (or whatever test recipient is configured for the first cycle) for delivery.

**09:00 PT:** No further automated action. If state is not `paid`, `bonus-payroll-deadline-missed` ntfy fires. This is the failure-mode escalation — Bill manually intervenes.

---

## First-cycle smoke test — Period 13

Period 13 is the first canonical bi-weekly cycle (Tue Jun 9 → Mon Jun 22, pay date Fri Jun 26).

- Tue Jun 9 onward: Janette and Rick key daily entries
- Mon Jun 22 17:30 PT: close cron fires for both sites
- Tue Jun 23 (morning): signers sign
- Tue Jun 23 09:00 PT hard deadline: PDFs in payroll inbox

When Period 13 closes cleanly and lands in payroll on time, the cadence is operational.

---

## Troubleshooting

### Cron didn't fire at 17:30 Mon

Container TZ should be UTC; the cron schedule converts via Pacific math. If the cron's tick time is correct but no periods transitioned, check:
- `bonus_pay_periods.period_end = ?` (what does the script see as Pacific today?)
- `state = 'draft'` for the matching row?
- Pacific time math via `@/lib/time` — `appTodayISO()` returns what?

### Auto-override didn't fire at 08:30 Tue

Check the escalation cron's last tick log:
- Did the script even run? If not, cron schedule issue.
- Did the script find unsigned periods?
- Did the auto-override actor user record validate? (script logs the actor lookup)
- If the actor user is inactive or missing, the script publishes an urgent ntfy "auto-override actor unavailable" and exits without signing. Fix the actor account, then sign manually via UI.

### PDF generated but didn't email

M365 mail-send fail-open: PDF is in R2, audit log records the generation, but mail-send wasn't configured. Verify `~/.dr3-vision-secrets/m365.env` is loaded and contains valid credentials per `docs/operator/m365-mail-send-setup.md`.

### Eugene tile not showing for Rick

Verify Rick's `primary_site_code = 'eugene'` in the users table:

```bash
docker compose exec postgres psql -U postgres -d dr3_vision -c "
SELECT email, name, role, primary_site_id, (SELECT code FROM sites WHERE id = primary_site_id) AS site_code
FROM users WHERE email = 'rick.albritton@svdp.us';"
```

If site_code is null or wrong, update via `/admin/users` panel.

### Wrong site signed at Eugene by Kelsey

Kelsey's primary signature slot at Eugene is `ops`, not `facility`. If she clicks the facility-signer button, the access check returns 403. To sign facility on Eugene as Kelsey, she uses the "Sign on behalf of Rick" override link instead. The signature chain (T-208) enforces this.

---

## Rollback plan

If the bi-weekly cadence introduces a critical bug post-cutover and you need to revert temporarily:

1. **Don't** roll back the schema — too disruptive once data lands.
2. Disable the bonus cron services:
   ```bash
   docker compose stop bonus-period-close bonus-escalation
   ```
3. Bill manually drives the cycle via the existing admin amendment / signature UI. PDFs still generate, mail still sends, but the scheduled close + escalation don't fire.
4. Fix the bug, re-deploy, restart the cron services.

The schema rename is forward-only — there is no "revert the rename" path that's worth taking. Diagnose forward, ship a fix.
