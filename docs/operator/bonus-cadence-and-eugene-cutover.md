# Bonus cadence + Eugene cutover — operator runbook

Companion to **ADR-0019.1** (bi-weekly cadence) and **ADR-0019.2** (Eugene site
enablement). This runbook covers the **Mon Jun 8, 2026** cutover: the bonus
reporting cadence flips from monthly to bi-weekly and Eugene goes live as a
second bonus site alongside Woodland.

This document reflects the addendum **as built** on branch `sprint-2-addendum`
(Waves A–D, T-201 … T-215; tsc clean, 648 tests, lint clean). Where the original
draft listed open options, this runbook records the decisions Bill actually made.

**Who does this:** Bill, with a SVdP M365 admin on standby only if an Entra
account needs fixing.

**When:** Sun Jun 7 EOD (merge + deploy + verify) → Mon Jun 8 17:30 PT (first
close fire) → Tue Jun 9 09:00 PT (first hard payroll deadline, only if a period
actually closes Mon — see Period 12 below).

---

## Pre-cutover checklist

### 1. Period 12 disposition — DECIDED: **SKIP**

Period 12 of 2026 spans **Tue May 26 → Mon Jun 8**. The bonus surface shipped to
production Sat Jun 6 with no production daily entries keyed. The first close cron
fires Mon Jun 8 17:30 PT against Period 12.

**Bill's decision: skip Period 12.** No fabricated counts, no signature workflow,
no payroll PDF for Period 12. **Period 13** (Tue Jun 9 → Mon Jun 22, pay date
Fri Jun 26) is the first canonical bi-weekly payroll PDF.

How the skip is done **as built**: an admin-only route transitions the draft
Period 12 row to the terminal `skipped` state.

```
POST /api/bonus/months/<period-id>/skip
```

- The route gates through `requireBonusAccess()` (site-scoped) **and**
  additionally requires `ctx.isAdmin` — managers (Janette / Morena / Rick) get a
  server-side **403**, never trusting the client. The state machine enforces the
  same admin-only constraint as a backstop (`draft → skipped` is in
  `ADMIN_ONLY_TRANSITIONS`).
- Only a `draft` period can be skipped; a period that has already left `draft`
  returns **409**.
- The period is site-scoped by id, so an admin cannot skip another site's period.
- `skipped` is **terminal** — a skipped period is permanently inert (no daily
  entries, no signatures, no PDF).

Skip **both** Period 12 rows (Woodland + Eugene) at deploy time — there are two
seeded rows (one per site). Do this from the admin UI, or POST the skip route for
each Period 12 id. After skipping, the Mon Jun 8 17:30 close cron finds no
`draft` period with `period_end = 2026-06-08` and logs a clean no-op.

> Do **not** run a raw `UPDATE bonus_pay_periods SET state='skipped'` against the
> production DB. The route writes the audit-log row and state-gauge metric; the
> raw SQL in the earlier draft bypasses the audited state machine. Use the route.

### 2. Eugene processor-roster bootstrap — entered via the UI, NOT seeded

The Eugene processor roster is **not** seeded. **Rick (or Bill) enters Eugene
processors in-app after cutover** at `/bonus/employees` (Eugene site), before
keying the first Period 13 daily entries on Tue Jun 9. ~30 seconds per processor;
typically 5–15 processors = under 10 minutes total.

There is no `bonus_employees_eugene.csv` seed step in this build — the roster is a
post-cutover, in-app data-entry task owned by Rick. Woodland's roster is likewise
manager-maintained.

### 3. Signature-chain identity note — `bill.barnard@` vs `operations@`

The signature-chain seed (`prisma/seed/bonus_signature_chains.csv`) identifies
all signers and override actors by **email**: it references Bill as
`bill.barnard@svdp.us`. But `prisma/seed/users.csv` seeds Bill's account as
`operations@svdp.us` (his current Director-of-Operations identity).

The seed bridges this with an explicit alias map in `prisma/seed.mjs`:

```js
// resolves the chain-CSV email → the actual seeded user email
'bill.barnard@svdp.us': 'operations@svdp.us'
```

So today the seed **aliases `bill.barnard@svdp.us` → `operations@svdp.us`**.
This is intentional and documented in `seed.mjs`: until `users.csv` adopts
`bill.barnard@` (out of scope — it would change an already-seeded identity),
the chain references resolve to `operations@`.

**Operational implication:** when Bill signs in via Entra SSO, the account that
must be active is the one seeded as `operations@svdp.us`. If SVdP later renames
Bill's mailbox to `bill.barnard@svdp.us`, either (a) update `users.csv` and drop
the alias, or (b) keep the alias — but verify the Entra-authenticated identity
maps to the same user row. The auto-override actor (Tue 08:30 PT) is Bill's user
row regardless of which email label fronts it.

### 4. Verify Entra account states

The signature-chain seed references these users by email; the seed will throw if
a referenced user can't be resolved. Confirm in Entra these accounts are
**active and not locked** before deploy:

- `operations@svdp.us` (Bill — admin; universal auto-override actor; aliased from
  `bill.barnard@svdp.us` in the chain seed)
- `kelsey.ruhland@svdp.us` (Kelsey — admin; Eugene ops signer; Eugene facility
  override backup)
- `morena.gomez@svdp.us` (Morena — manager; Woodland ops signer; Woodland
  facility override backup)
- `janette.thomas@svdp.us` (Janette — manager; Woodland facility signer)
- `rick.albritton@svdp.us` (Rick — manager; Eugene facility signer)

> Seed accounts are seeded **inactive**; an admin activates each account via the
> `/admin/users` panel after the user's first Entra SSO sign-in.

---

## Deploy steps (manual deploy to CHAD-HQ)

Production is `dr3-vision.svdp.us` on CHAD-HQ. The deploy is manual: build the
image, run migrations, seed, recreate the cron containers, force-recreate the app.

```bash
ssh chad-hq
cd /opt/dr3-vision
```

### 1. Merge to main

```bash
git fetch origin
git checkout main
git merge --ff-only origin/sprint-2-addendum
git log --oneline -5   # confirm the addendum commits are at the tip
```

### 2. Build the app image

The cron containers and the app all run the same locally-built image
`dr3-vision-app:local`.

```bash
docker compose build app
```

### 3. Apply migrations

```bash
docker compose run --rm app npx prisma migrate deploy
```

Expect the bi-weekly migration to apply:

```
Applying migration `20260606_bi_weekly_pay_periods`
...
Database schema is up to date.
```

This migration renames `bonus_months → bonus_pay_periods`, renames the
identity-named signature columns to site-neutral `facility_*` / `ops_*`, adds
`period_number` / `period_year` / `pay_date` / `*_auto_override_at`, adds the
`skipped` enum value, and adds the `bonus_signature_chains` table (ADR-0019.1 §5,
ADR-0019.2 §2). It is pre-data safe — no production bonus rows exist yet.

### 4. Seed

```bash
docker compose run --rm app npx prisma db seed
```

Expect (among the other seed tables):

```
bonus_pay_periods   = 52   (26 periods × 2 sites)
bonus_signature_chains = 2 (Woodland + Eugene)
```

The seed asserts these exact counts and **throws on mismatch**, then applies the
post-seed DDL (NOT NULL on `period_number` / `period_year` / `pay_date`, plus the
`(site_id, period_year, period_number)` unique index).

### 5. Skip Period 12 (per the decision above)

After seeding, skip both Period 12 rows via the admin skip route (UI or
`POST /api/bonus/months/<id>/skip` for each). See "Period 12 disposition" above.

### 6. Recreate the bonus cron containers

There are **two** bonus cron daemons in `docker-compose.yml`, and the old monthly
`bonus-month-close` is **gone**:

| Service                  | Script                               | Fires (Pacific)                        | Purpose                                                                                         |
| ------------------------ | ------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bonus-period-close`     | `scripts/bonus-period-close.mjs`     | daily 17:30 PT                         | `draft → pending_signatures` for any period whose `period_end == today`; emails facility signer |
| `bonus-escalation-check` | `scripts/bonus-escalation-check.mjs` | daily 06:00 / 07:30 / 08:30 / 09:00 PT | t1 warn → t2 urgent → t3 auto-override → t4 deadline-miss check                                 |

> `scripts/bonus-month-close.mjs` no longer exists. If you see a
> `bonus-month-close` container still running on the host from a previous
> release, stop and remove it.
>
> `scripts/bonus-eod-check.mjs` (the 17:00 PT "active employee missing today's
> entry" daily check from Sprint 2) is **not** a separate compose service on this
> branch — it is the existing daily EOD enforcement and is orthogonal to the
> bi-weekly close. Do not expect a third bonus cron container.

Both daemons run the same `dr3-vision-app:local` image and POST internal
loopback-guarded routes (`/api/internal/bonus/close-months`,
`/api/internal/bonus/escalation-check?tier=...`). They sleep until the next
Pacific wall-clock fire instant, recomputed each cycle so they survive the
Mar/Nov DST shifts.

Recreate them so they pick up the new image/scripts:

```bash
docker compose up -d --force-recreate --no-deps bonus-period-close bonus-escalation-check
```

### 7. Force-recreate the app

```bash
docker compose up -d --force-recreate --no-deps app
```

---

## Day-of verification — Sun Jun 7 EOD

```bash
# 1. Migration applied
docker compose run --rm app npx prisma migrate status
#    Expect: "Database schema is up to date!"

# 2. Pay-period count: 52 total (26 per site)
docker compose exec postgres psql -U postgres -d dr3_vision -c "
  SELECT s.code, COUNT(*) FROM bonus_pay_periods p
  JOIN sites s ON s.id = p.site_id GROUP BY s.code;"
#    Expect: woodland 26, eugene 26 (52 total)

# 3. Signature chains: 2 rows (Woodland + Eugene)
docker compose exec postgres psql -U postgres -d dr3_vision -c "
  SELECT s.code, sc.facility_signer_user_id, sc.ops_signer_user_id,
         sc.auto_override_actor_user_id
  FROM bonus_signature_chains sc JOIN sites s ON s.id = sc.site_id;"
#    Expect: two rows; Woodland = Janette/Morena/Bill, Eugene = Rick/Kelsey/Bill

# 4. Period 12 skipped (both sites)
docker compose exec postgres psql -U postgres -d dr3_vision -c "
  SELECT s.code, p.state FROM bonus_pay_periods p JOIN sites s ON s.id=p.site_id
  WHERE p.period_year=2026 AND p.period_number=12;"
#    Expect: woodland skipped, eugene skipped

# 5. Both cron containers running
docker compose ps bonus-period-close bonus-escalation-check
#    Expect: both "Up". (There is no bonus-month-close container.)

# 6. Pacific-time sanity — healthz reports the app's Pacific "today"
curl -s https://dr3-vision.svdp.us/healthz | jq .pacific_today
#    Expect: "2026-06-07" (matches Pacific wall clock, NOT raw UTC)
```

### Tile visibility per role (manual browser check)

The Eugene enablement (ADR-0019.2 §1/§6) expands the bonus access matrix; the
tile shape is unchanged, only the matrix widens.

- **Bill / Kelsey (admin):** Vision Dashboard shows the **Bonus Management** tile;
  clicking it renders the **site picker** (Woodland | Eugene). Selection persists
  for the session; a "switch site" link in the bonus shell header changes it.
- **Rick (Eugene manager):** **now sees** the Bonus Management tile; clicking
  routes straight to **Eugene** (no picker). Rick gets **403** on any Woodland
  bonus route.
- **Janette (Woodland manager):** sees the tile; routes straight to **Woodland**;
  **403** on Eugene.
- **Morena (California ops):** sees the tile; **Woodland only** — Morena does NOT
  see Eugene (Eugene is Oregon; per Bill, only Rick and an admin see Eugene).
- **Operators:** no bonus access (PIN flow can't reach `/bonus`).

---

## First-cycle verification timeline

The first cycle that actually runs the close-and-sign workflow is **Period 13**
(Period 12 is skipped). The timeline is the same one the escalation cron
implements (ADR-0019.1 §3).

### Mon Jun 8

- **17:00 PT** — EOD daily check fires (existing `bonus-eod-check` enforcement)
  if any active employee at either site is missing today's entry. With Period 12
  skipped this is informational only.
- **17:30 PT** — `bonus-period-close` fires. With Period 12 **skipped**, no
  `draft` period has `period_end = 2026-06-08`, so the close logs **"no periods
  to close"** — a clean no-op. (Had Period 12 not been skipped, it would have
  transitioned `draft → pending_signatures` and emailed the facility signer.)

### Tue Jun 9 (the real first close is Period 13 ending Mon Jun 22 — see below)

Because Period 12 is skipped, there is **no signature/escalation activity on Tue
Jun 9 for Period 12**. The escalation tiers below describe what the cron does on
the Tuesday **after a real period close**:

| Time PT     | Tier | Action                                                                                                                                                                                                                                                              |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 06:00       | t1   | Low-urgency ntfy to Bill if any slot on the just-closed period is still unsigned (`dr3-vision-system`, default priority).                                                                                                                                           |
| 07:30       | t2   | **Urgent** ntfy to all override-authorized humans (Bill + Morena for Woodland; Bill + Kelsey for Eugene), with the override list in the body.                                                                                                                       |
| 08:30       | t3   | **Auto-override.** Any still-unsigned slot is system-signed **as Bill** (`actor = system:bonus-escalation`, `*_auto_override_at` stamped, ADR-0019.1 attestation language on the PDF). Triggers PDF render + R2 upload + M365 Graph mail-send to `payroll@svdp.us`. |
| 08:30–09:00 | —    | 30-min buffer for PDF render + R2 + Graph sendMail (with retry).                                                                                                                                                                                                    |
| 09:00       | t4   | **Hard deadline check.** If the period is not yet `paid`, fire `bonus-payroll-deadline-missed:<site>:<period>` at **urgent**. Bill intervenes manually.                                                                                                             |

### First canonical bi-weekly cycle — Period 13

- **Tue Jun 9 onward:** Janette (Woodland) and Rick (Eugene) key daily entries.
  Rick adds the Eugene roster first (see pre-cutover step 2).
- **Mon Jun 22 17:30 PT:** `bonus-period-close` closes **both** sites' Period 13
  (`draft → pending_signatures`), emails each facility signer.
- **Tue Jun 23 morning:** signers sign; escalation tiers fire as above for any
  unsigned slot.
- **Tue Jun 23 09:00 PT:** signed PDFs must be in `payroll@svdp.us`.
- **Fri Jun 26:** pay date.

When Period 13 closes cleanly and lands in payroll on time, the bi-weekly cadence
is operational.

### Auto-override behavior (the load-bearing mechanism)

The Tue 08:30 PT auto-override is what guarantees the 09:00 PT deadline even if a
signer is absent. As built:

- It signs every still-unsigned slot **as Bill** — the universal auto-override
  actor for **both** sites (Kelsey is NOT a backup actor for Eugene; ADR-0019.2
  §9).
- It writes an `audit_log` row (`actor_label = system:bonus-escalation`,
  `actor_user_id = Bill`, full before/after JSON) and fires a `dr3-vision-system`
  ntfy confirming the slot(s) overridden.
- The PDF signature block flags the automated origin explicitly, e.g.:
  _"Signed by Bill Barnard, Administrator, on behalf of Janette Thomas, Facility
  Manager. System-applied admin override per ADR-0019.1 escalation policy.
  Janette Thomas did not sign by 08:30 AM PT."_
- **Then it advances `signed → paid`** once M365 confirms delivery
  (`delivered:true`). This is the T-211 step-5 fix (commit `d5b18a9`): a fail-open
  no-op or a failed send leaves the period `signed`, so the t4 check fires on a
  **real** miss — not a false alarm. Both the manual second-signature path and the
  t3 auto-override path go through the shared payroll-delivery trigger, so both
  reach `paid`.
- **Critical dependency:** Bill's user record (seeded as `operations@svdp.us`)
  must be active and unlocked. If the actor can't be resolved, the cron publishes
  an urgent "auto-override actor unavailable" ntfy and exits without signing — a
  human must then sign via the UI. The 07:30 t2 urgent ntfy gives the override
  humans a 60-minute window to sign manually before 08:30.

---

## Signature chains (as seeded)

Both chains live in `bonus_signature_chains`, one row per site, seeded from
`prisma/seed/bonus_signature_chains.csv` (ADR-0019.2 §2). Override is asymmetric:
admin-or-peer can override the facility slot; admin-only can override the ops slot.

### Woodland

| Slot                               | Primary signer     | Override authority |
| ---------------------------------- | ------------------ | ------------------ |
| Facility                           | **Janette** Thomas | Bill **or** Morena |
| Ops                                | **Morena** Gomez   | Bill only          |
| Auto-override actor (Tue 08:30 PT) | —                  | **Bill**           |

### Eugene

| Slot                               | Primary signer     | Override authority |
| ---------------------------------- | ------------------ | ------------------ |
| Facility                           | **Rick** Albritton | Bill **or** Kelsey |
| Ops                                | **Kelsey** Ruhland | Bill only          |
| Auto-override actor (Tue 08:30 PT) | —                  | **Bill**           |

Notes:

- **Kelsey signs Eugene ops** even though her role is `admin` — the sign-route
  check is "may this user occupy this slot for this site," not "is this user a
  manager." Admins may occupy any slot they're configured for (ADR-0019.2 §3).
- If Kelsey needs to cover Eugene **facility**, she signs via the "override the
  facility slot" path (Bill or Kelsey are facility override actors), not by
  occupying the facility primary slot.
- Bill is the **universal** auto-override actor for both sites — Kelsey is never
  the auto-override fallback (ADR-0019.2 §9).

---

## Troubleshooting

### Close cron didn't transition a period at 17:30 PT

The daemon fires daily at 17:30 PT and only transitions periods where
`state = 'draft' AND period_end = appToday()` (Pacific). If the tick happened but
nothing transitioned, check:

- Is there a `draft` period whose `period_end` equals today's Pacific date?
- Was the period already moved out of `draft` (e.g. skipped, or a prior fire)?
- What does `@/lib/time` `appTodayISO()` return — does it match the seeded
  `period_end`? (Container clocks are UTC; the close decision is Pacific-aware.)

### Auto-override didn't fire at 08:30 PT Tue

Check the `bonus-escalation-check` daemon's last t3 tick log:

- Did the daemon run / POST the t3 route? If not, the daemon may be down —
  `docker compose ps bonus-escalation-check`.
- Did it find unsigned slots on the just-closed period?
- Did the auto-override actor (Bill, `operations@svdp.us`) resolve and validate?
  If the actor is inactive/missing, the script publishes an urgent
  "auto-override actor unavailable" ntfy and exits without signing — fix the
  account, then sign manually via UI.

### PDF generated but didn't email (period stuck at `signed`)

M365 mail-send is fail-open: the PDF is in R2 and the audit log records the
generation, but a fail-open no-op leaves the period `signed` (not `paid`), so the
t4 check correctly flags it. Verify `~/.dr3-vision-secrets/m365.env` is loaded
with valid credentials per `docs/operator/m365-mail-send-setup.md`, then
re-trigger delivery.

### Eugene tile not showing for Rick

Verify Rick's `primary_site_code = 'eugene'`:

```bash
docker compose exec postgres psql -U postgres -d dr3_vision -c "
  SELECT u.email, u.name, u.role,
         (SELECT code FROM sites WHERE id = u.primary_site_id) AS site_code
  FROM users u WHERE u.email = 'rick.albritton@svdp.us';"
```

If `site_code` is null or wrong, fix via `/admin/users`.

### Kelsey got 403 trying to sign Eugene facility

Kelsey's primary Eugene slot is **ops**, not facility. To cover facility she uses
the facility **override** path (she's a facility override actor for Eugene), not
the facility primary-sign button. The signature-chain gate (T-208) enforces this.

---

## Rollback plan

If a critical bug appears post-cutover:

1. **Do not** roll back the schema — too disruptive once data lands. The
   `bonus_months → bonus_pay_periods` rename is forward-only; diagnose forward.
2. Stop the bonus cron daemons so they don't fire on the buggy path:
   ```bash
   docker compose stop bonus-period-close bonus-escalation-check
   ```
3. Bill drives the cycle manually via the admin signature / amendment UI. PDFs
   still generate and mail still sends; only the scheduled close + escalation
   don't fire.
4. Fix the bug, rebuild the image, redeploy, restart the cron daemons.

---

## References

- ADR-0019.1 — Bi-weekly pay-period cadence and signature timing
  (`docs/adr/0019.1-bonus-cadence-bi-weekly.md`)
- ADR-0019.2 — Eugene site enablement for Bonus Management
  (`docs/adr/0019.2-bonus-eugene-site-enablement.md`)
- ADR-0019 — Bonus Management System (`docs/adr/0019-bonus-management-system.md`)
- ADR-0021 — M365 Graph mail-send (`docs/adr/0021-m365-graph-mail-send.md`)
- `docs/operator/m365-mail-send-setup.md` — payroll delivery credential setup
- `docs/SPRINT-2-ADDENDUM.md` — ticket breakdown (T-201 … T-215)
- `prisma/seed/bonus_pay_periods_2026.csv` — all 26 periods × 2 sites
- `prisma/seed/bonus_signature_chains.csv` — both signature chains
- `prisma/migrations/20260606_bi_weekly_pay_periods/migration.sql` — the migration
