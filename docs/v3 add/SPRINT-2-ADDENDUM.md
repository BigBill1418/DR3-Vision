# Sprint 2 addendum — bi-weekly cadence + Eugene enablement

**Filed:** 2026-06-06
**Theme:** Convert Bonus Management from monthly → bi-weekly cadence (ADR-0019.1) and enable Eugene as a second site (ADR-0019.2). Both ship on the same Monday cutover.

This addendum reuses the wave-dispatch shape from `docs/SPRINT-2-PLAN.md`. Tickets are numbered **T-200 series** to give clean separation from the original T-100s. Mark `[x]` as complete.

## Read order for Claude Code agents

```
1. CLAUDE.md                                          (project-wide rules, unchanged)
2. docs/SPRINT-2-PLAN.md                              (original Sprint 2, for context)
3. docs/SPRINT-2-ADDENDUM.md                          (THIS DOCUMENT)
4. docs/adr/0019-bonus-management-system.md           (original bonus ADR)
5. docs/adr/0019.1-bonus-cadence-bi-weekly.md         (NEW — supersedes monthly)
6. docs/adr/0019.2-bonus-eugene-site-enablement.md    (NEW — Eugene)
7. prisma/schema.prisma.cadence.patch                 (NEW — schema diff)
8. prisma/migrations/20260606_bi_weekly_pay_periods/migration.sql  (NEW)
9. prisma/seed/bonus_pay_periods_2026.csv             (NEW)
10. prisma/seed/bonus_signature_chains.csv            (NEW)
11. Existing repo at sprint-2 tip                     (the bonus surface as currently built)
```

Total reading: ~3,500 lines of new content + the existing bonus surface for context.

## Hard rules for this addendum

In addition to the original Sprint 2 hard rules in `docs/SPRINT-2-PLAN.md`:

1. **Period-named everywhere.** No new code reads or writes `month_start`/`month_end`/`janette_*`/`morena_*` — those names are gone post-migration. Any TS error referencing the old names is a missed refactor site.
2. **Site identity comes from `bonus_signature_chains`, never hardcoded.** No code says `if (siteCode === 'woodland') signAsJanette()`. The signature chain config is the source of truth for "who signs this slot at this site."
3. **Auto-override actor is configurable, not hardcoded as Bill.** Read from `bonus_signature_chains.auto_override_actor_user_id`. Today it's Bill for both sites; tomorrow it could be different. One source of truth.
4. **Pacific-aware date math everywhere.** Use `@/lib/time` for any "today / period_end / pay_date / cron-tick-day" decisions. Never `new Date().getDay()` raw.
5. **State machine still owns all transitions.** Including auto-override transitions — they go through the same path as manual overrides, just with `actor_user_id = (chain).auto_override_actor_user_id` and the new `*_auto_override_at` timestamp set.
6. **Tile visibility unchanged in shape — only the matrix expands.** `canSeeTile()` already calls `checkBonusAccess()`. The access function gains Eugene awareness; the tile component does not.

---

## Wave A — Foundation (parallel)

### [ ] T-200: Schema migration — table + column renames + new columns

Apply the migration in `prisma/migrations/20260606_bi_weekly_pay_periods/migration.sql`. Update `prisma/schema.prisma` to match `prisma/schema.prisma.cadence.patch`. Regenerate Prisma client.

**Acceptance:**

- Migration applies cleanly against a Sprint-2-tip baseline DB
- `prisma generate` produces typed client with `BonusPayPeriod` (not `BonusMonth`), `BonusPayPeriodState` enum, renamed columns
- All 30+ TypeScript files that reference `bonus_months` / `BonusMonth` / `janette_*` / `morena_*` compile (the refactor is T-202)
- Rollback path: a separate down-migration script that reverses the renames (committed to the migration folder as `down.sql` for emergency use; not run by Prisma migrate)

### [ ] T-201: Pay-period + signature chain seed

Drop the two new seed CSVs into the seed pipeline:

- `prisma/seed/bonus_pay_periods_2026.csv` — 26 periods × 2 sites = 52 rows
- `prisma/seed/bonus_signature_chains.csv` — 2 rows (Woodland + Eugene)

Extend `prisma/seed.mjs` with two new seed steps: `seedBonusPayPeriods()` and `seedBonusSignatureChains()`. Both upsert by `(site_id, period_year, period_number)` / `(site_id)` respectively so re-running the seed is idempotent.

After upsert, the seed runner issues the post-seed DDL:

```sql
ALTER TABLE bonus_pay_periods ALTER COLUMN period_number SET NOT NULL;
ALTER TABLE bonus_pay_periods ALTER COLUMN period_year   SET NOT NULL;
ALTER TABLE bonus_pay_periods ALTER COLUMN pay_date      SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bonus_pay_periods_site_id_period_year_period_number_key
  ON bonus_pay_periods(site_id, period_year, period_number);
```

These run after data is in place because the columns were created NULL-allowed in the migration.

**Acceptance:**

- Fresh DB after `prisma migrate deploy && prisma db seed` has 52 pay-period rows + 2 signature chain rows
- Re-running the seed is a no-op (idempotent upserts)
- Post-seed DDL applies cleanly
- Querying `bonus_pay_periods WHERE site_code='eugene' AND period_year=2026 AND period_number=13` returns one row with `period_start=2026-06-09`, `period_end=2026-06-22`, `pay_date=2026-06-26`

### [ ] T-202: TypeScript-wide rename refactor

The largest single ticket in this addendum. Every reference to the old names must update:

| Old                                                | New                                                   |
| -------------------------------------------------- | ----------------------------------------------------- |
| `BonusMonth` type                                  | `BonusPayPeriod`                                      |
| `BonusMonthState` enum                             | `BonusPayPeriodState`                                 |
| `bonus_months` (table reference in Prisma queries) | `bonus_pay_periods` (handled by Prisma client rename) |
| `bonus_month_id` field                             | `bonus_pay_period_id`                                 |
| `month_start` field                                | `period_start`                                        |
| `month_end` field                                  | `period_end`                                          |
| `janette_signed_*` fields                          | `facility_signed_*`                                   |
| `morena_signed_*` fields                           | `ops_signed_*`                                        |
| `janette_override_*`                               | `facility_override_*`                                 |
| `morena_override_*`                                | `ops_override_*`                                      |
| `BonusJanetteSigner` relation                      | `BonusFacilitySigner`                                 |
| `BonusMorenaSigner` relation                       | `BonusOpsSigner`                                      |
| `bonus_months_signed_as_janette` user field        | `bonus_pay_periods_signed_as_facility`                |
| `bonus_months_signed_as_morena` user field         | `bonus_pay_periods_signed_as_ops`                     |
| `bonus_months_amended` user field                  | `bonus_pay_periods_amended`                           |

Function-level renames (in `src/lib/bonus/`):

| Old function                 | New function                     |
| ---------------------------- | -------------------------------- |
| `getOrCreateDraftMonth`      | `getOrCreateDraftPayPeriod`      |
| `closeMonthsDueForSignature` | `closePayPeriodsDueForSignature` |
| `listBonusMonths`            | `listBonusPayPeriods`            |
| `monthWindow`                | `payPeriodWindow`                |
| `parseMonthFilter`           | `parsePayPeriodFilter`           |

URL paths under `/bonus/months/*` **stay as-is** (preserves bookmarks per ADR-0019.1 §7). Only the internal data layer / types rename.

**Acceptance:**

- `npx tsc --noEmit` clean
- `npx next lint --max-warnings 0` clean
- All existing bonus tests pass after rename (some test names will update; their assertions don't change)
- `rg -i "bonus_month|janette_signed|morena_signed|BonusMonth\b|monthWindow|parseMonthFilter"` returns zero hits outside ADRs, migration SQL, CHANGELOG, and code comments referencing the old names historically

### [ ] T-203: State machine — period boundaries replace month boundaries

`src/lib/bonus/state-machine.ts`:

- `closePayPeriodsDueForSignature(now)` looks up `bonus_pay_periods WHERE period_end = appToday() AND state = 'draft'` (Pacific-aware) instead of "month just ended."
- All `ALLOWED_TRANSITIONS` entries unchanged in shape; the values reference the renamed states.
- A new `skipped` terminal state is added to `ALLOWED_TRANSITIONS` with one legal in-edge: `draft → skipped` (admin-only, used for Period 12 bootstrap per ADR-0019.1 "Bootstrapping question").

**Acceptance:**

- All existing state-machine tests pass with renamed fields
- New tests cover: `draft → skipped` admin-only transition; non-admin → 403; skipped period blocks daily entry mutations; skipped period blocks signature workflow

### [x] T-204: Period close cron — Mon 17:30 PT

Replace `scripts/bonus-month-close.mjs` with `scripts/bonus-period-close.mjs`. The new script:

- Imports the compiled bonus tx layer (similar to how the MyMRC cron imports its compiled bundle)
- Runs continuously (long-running cron daemon), or runs on-demand via a host cron at daily 17:30 PT
- On each tick (or daily fire), calls `closePayPeriodsDueForSignature(appToday())` which transitions any matching periods to `pending_signatures` and fires the signature-request email (existing `notifyPendingSigner` path)

Update `docker-compose.yml`'s relevant cron service to use the new script name + schedule.

**Acceptance:**

- A test period with `period_end = today (Pacific)` and `state = 'draft'` transitions to `pending_signatures` when the cron fires
- A test period with `period_end != today` is untouched
- The signature-request email path fires correctly (audit log records `system:signature-request`)
- Cron runs idempotent — second fire on the same day does not double-transition (state machine rejects)

### [ ] T-205: Escalation cron — Tue 06:00 / 07:30 / 08:30 PT

New `scripts/bonus-escalation-check.mjs` daemon. On each tick (Pacific-aware), examines all `bonus_pay_periods` where `state IN ('pending_signatures', 'partially_signed')` AND `period_end = appToday() - 1 day` (yesterday's-close periods). For each unsigned slot:

- At 06:00 PT: publish low-urgency ntfy to `dr3-vision-system`, fingerprint `bonus-escalation-warning:<site>:<period-id>:t1`, priority 3
- At 07:30 PT: publish urgent ntfy, same fingerprint base with `:t2` suffix, priority 4. Include in the message body the list of override-authorized humans from `bonus_signature_chains`.
- At 08:30 PT: invoke the signature service with `actor_user_id = chain.auto_override_actor_user_id` and set the new `*_auto_override_at` timestamp. Triggers PDF generation + M365 mail-send via the existing post-signature side-effect chain.

Cron schedule: implementable as three separate cron entries OR one daemon that wakes at the three times. Daemon shape preferred (single process, single restart policy).

**Acceptance:**

- A `pending_signatures` period on a Tuesday morning produces the right ntfy publish at 06:00 and 07:30 (verifiable via mock ntfy publisher)
- At 08:30, an unsigned slot gets `*_signed_by_user_id = bill`, `*_override_actor_id = bill`, `*_auto_override_at = (tick time)`, `*_override_reason = "ADR-0019.1 escalation policy..."`
- Audit log records `system:bonus-escalation` actor label
- Idempotent: a slot signed by 08:25 manually does not get auto-overridden at 08:30 (the state-machine check sees it's already signed)
- A `signed` period (both slots already signed) generates no escalation events at all

### [ ] T-206: Tier 4 — payroll-deadline-missed ntfy at 09:00

Same daemon as T-205. At 09:00 PT, examines all yesterday's-period rows where `state != 'paid'` (PDF didn't ship). Publishes ntfy `bonus-payroll-deadline-missed:<site>:<period-id>` at urgent priority. Bill manually intervenes.

**Acceptance:**

- A period where auto-override fired at 08:30 but mail-send hung past 09:00 produces the deadline-missed ntfy
- A period that successfully reached `paid` state by 09:00 does NOT produce the ntfy
- Cooldown prevents repeated fires on the same period

---

## Wave B — Eugene access + signature chain (parallel after Wave A)

### [ ] T-207: Eugene-aware access gate

Extend `src/lib/bonus/access.ts` `checkBonusAccess()` per ADR-0019.2 §1.

**Function shape:**

```typescript
type BonusAccess = {
  allowed: boolean;
  sites: ('woodland' | 'eugene')[]; // empty array if !allowed
};

export async function checkBonusAccess(
  session: Session,
  requestedSite?: SiteCode,
): Promise<BonusAccess>;
```

**Behavior:**

- Admin (Bill, Kelsey) → `{allowed: true, sites: ['woodland', 'eugene']}` regardless of `requestedSite`
- Manager with `primary_site_code='woodland'` (Janette) → `{allowed: true, sites: ['woodland']}`
- Manager with `primary_site_code='eugene'` (Rick) → `{allowed: true, sites: ['eugene']}`
- Manager with `primary_site_code=null` (Morena) → `{allowed: true, sites: ['woodland']}` (Morena is California-ops scoped; she does NOT see Eugene per ADR-0019.2 §1)
- Operator → `{allowed: false, sites: []}`

If `requestedSite` is set, narrow `sites` to just that one (and flip `allowed` to false if the user can't access it).

**Acceptance:**

- Janette `requestedSite='woodland'` → `{allowed: true, sites: ['woodland']}`
- Janette `requestedSite='eugene'` → `{allowed: false, sites: []}` → page returns 403
- Rick `requestedSite='eugene'` → `{allowed: true, sites: ['eugene']}`
- Rick `requestedSite='woodland'` → `{allowed: false, sites: []}`
- Bill `requestedSite=undefined` → `{allowed: true, sites: ['woodland', 'eugene']}`
- All existing bonus-route tests pass with the new access shape

### [x] T-208: Signature chain lookup + signature service Eugene awareness

New `src/lib/bonus/signature-chain.ts`:

```typescript
export async function getSignatureChain(siteId: string): Promise<{
  facility_signer_user_id: string;
  facility_override_actor_user_ids: string[]; // parsed from CSV column
  ops_signer_user_id: string;
  ops_override_actor_user_ids: string[];
  auto_override_actor_user_id: string;
}>;
```

Cached per-site for the request lifecycle (chain doesn't change mid-request).

Update `src/lib/bonus/signatures.ts` to use the chain instead of hardcoded "Janette signs facility, Morena signs ops":

- `canSignSlot(user, slot, siteId)` — checks `user.id === chain.{slot}_signer_user_id`
- `canOverrideSlot(user, slot, siteId)` — checks `user.id IN chain.{slot}_override_actor_user_ids`
- `getAutoOverrideActor(siteId)` — returns `chain.auto_override_actor_user_id`

**Acceptance:**

- Rick can sign facility for Eugene (`canSignSlot(rick, 'facility', eugeneId) === true`)
- Rick cannot sign facility for Woodland (`canSignSlot(rick, 'facility', woodlandId) === false`)
- Kelsey can sign ops for Eugene
- Kelsey can sign ops for Woodland? **Yes by structure** — Kelsey is `role=admin` and admins can occupy any slot they're configured to. BUT only Eugene's chain configures her as the ops_signer. For Woodland, `ops_signer_user_id = morena`. So Kelsey signing Woodland's ops slot would be an override (allowed because she's admin), not a primary signature. Tests assert this distinction.
- Bill can override either slot at either site
- Morena can override Janette's facility slot but NOT Kelsey's ops slot (Eugene's chain doesn't list her as ops override)
- 27 tests covering the matrix

### [ ] T-209: PDF template — site-name + period naming

Update the bonus PDF render at `src/app/internal/bonus-pdf/[month-id]/page.tsx` (yes, route name still has 'month' — URL preservation per ADR-0019.1 §7).

Title block:

> **DR3 [site.name] Bonus Report — Period [period_number]: [period_start_label] – [period_end_label], [period_year]**
> _Pay date: [pay_date_label]_

Where `site.name` comes from `prisma.site.findUnique({where: {id}})` joined to the period. `period_start_label` / `period_end_label` use the Pacific-aware date formatter (e.g. "Jun 9" – "Jun 22"). `period_year` is the `period_year` column.

Signature attestation language adapts to slot-source. For a human override:

> _Signed by Bill Barnard, Administrator, on behalf of Janette Thomas, Facility Manager._
> _Reason: <facility_override_reason>_

For an auto-override (T-205-applied):

> _Signed by Bill Barnard, Administrator, on behalf of Janette Thomas, Facility Manager._
> _System-applied admin override per ADR-0019.1 escalation policy. Janette Thomas did not sign by 08:30 AM PT on Tue [date]._

Distinguished by `facility_auto_override_at IS NOT NULL` (system) vs `facility_override_actor_id IS NOT NULL AND facility_auto_override_at IS NULL` (manual override) vs `facility_signed_by_user_id IS NOT NULL AND facility_override_actor_id IS NULL` (primary signed).

**Acceptance:**

- A signed Period 13 for Woodland renders with the new title format and "Woodland" as site name
- A signed Period 13 for Eugene renders identically but with "Eugene"
- An auto-override attestation displays the ADR-0019.1 language
- A manual override attestation displays the human override language
- A primary-signed slot displays standard attestation
- PDF generated via Playwright matches the visual sample (verified by eye, regenerated and saved to `public/brand/dr3-bonus-report-sample-eugene-period-13.pdf` for ongoing reference)

### [ ] T-210: Vision Dashboard tile — Eugene visibility + site picker for admins

`src/lib/dashboard-tiles.ts`:

- `canSeeTile(session, 'bonus-management')` already calls `checkBonusAccess()`. With T-207's update, this returns true for Rick. No tile code change needed.

`src/app/bonus/page.tsx` (the entry page):

- Server-detects multi-site access via `checkBonusAccess()`
- If `sites.length === 1` → redirect to `/bonus?site=<the_one>` (existing behavior continues from there)
- If `sites.length > 1` → render a site picker: "Choose a site to view bonus data: [Woodland] [Eugene]"
- Site picker writes to a session-scoped field; subsequent bonus routes consult it
- Shell header at `/bonus/**` shows "Site: Woodland | switch" for admin sessions

**Acceptance:**

- Rick → tile visible → clicks → lands on `/bonus?site=eugene` → sees Eugene daily entry grid
- Janette → tile visible → clicks → lands on `/bonus?site=woodland`
- Morena → tile visible → clicks → lands on `/bonus?site=woodland` (her single accessible site)
- Bill → tile visible → clicks → site picker → selects Eugene → all subsequent bonus routes scope to Eugene
- Bill clicks "switch" in the shell header → site picker re-renders → can select Woodland

---

## Wave C — PDF + cron integration verification (parallel after Wave B)

### [ ] T-211: End-to-end test — Woodland Period 12 → 13 transition

Run a full simulation of the Mon Jun 8 → Tue Jun 9 close-and-sign cycle for Woodland. Use seeded data, not production:

1. Period 12 has draft state with daily entries for May 26 – Jun 8 (seeded test data)
2. Simulate Mon Jun 8 17:30 PT close cron → state `pending_signatures`, signature-request email queued
3. Simulate Janette signing at Mon Jun 8 18:00 PT → state `partially_signed`
4. Simulate Morena signing at Tue Jun 9 07:00 PT → state `signed`, PDF generated, mail-send queued
5. Simulate M365 send success → state `paid`, audit log records the send

**Acceptance:**

- All state transitions audited correctly
- PDF renders with "Period 12: May 26 – Jun 8, 2026 · Pay date Jun 12" title
- Test mail recipient receives the PDF (use test recipient, not real payroll)
- Period 13 (Tue Jun 9 → Mon Jun 22) is in `draft` state and accepting daily entries by Tue Jun 9 morning
- All test artifacts cleaned up post-test

### [ ] T-212: End-to-end test — Eugene parallel cycle

Repeat T-211 for Eugene, with Rick + Kelsey signing instead of Janette + Morena. Verify site isolation (no cross-contamination of audit log, no incorrect PDF site-name).

### [ ] T-213: End-to-end test — Auto-override path

Simulate a period where neither slot is manually signed by Tue 08:30 PT. Expect the escalation cron to:

1. Fire 06:00 low-urgency ntfy (test publisher captures)
2. Fire 07:30 urgent ntfy
3. At 08:30, sign both slots as Bill with the auto-override attestation
4. Trigger PDF generation + M365 send
5. PDF carries the ADR-0019.1 attestation language for both slots
6. Audit log records `system:bonus-escalation` actor

**Acceptance:** All steps verified in a single test run. PDF rendered and reviewed by eye for attestation correctness.

---

## Wave D — Polish, runbook, deploy (parallel after Wave C)

### [ ] T-214: Operator runbook — bonus cadence + Eugene cutover

Write `docs/operator/bonus-cadence-and-eugene-cutover.md` covering:

- Pre-cutover checklist (Period 12 disposition decision, Eugene roster bootstrap, secret rotation if needed)
- Deploy steps (force-recreate the app + cron containers)
- Day-of verification (escalation cron timer set correctly; signature chains seeded; tile visibility per role)
- First-cycle (Period 12 → 13 transition Mon evening Jun 8) verification

### [ ] T-215: Documentation updates

Update:

- `README.md` — note the bi-weekly cadence + Eugene-now-supported
- `PROJECT-CHARTER.md` — add §16.1 Sprint 2 addendum summary, reference ADRs 0019.1 + 0019.2
- `docs/adr/README.md` — index ADRs 0019.1 + 0019.2 under Sprint 2 section
- `CHANGELOG.md` — single entry summarizing the addendum work

### [ ] T-216: Production deploy + Monday go-live verification

Sun Jun 7 EOD or earlier:

- Push sprint-2-addendum tip to `main`
- Manual deploy to CHAD-HQ (until swarmpilot_deployer is back; the original Sprint 2 had to deploy manually too)
- Verify migration applied (`prisma migrate status`)
- Verify seed applied (52 pay-period rows, 2 signature-chain rows)
- Verify cron containers are running the new scripts (`docker compose ps`)
- Verify Pacific-time-aware date math (`/healthz` includes a `pacific_today` field that reads `appTodayISO()`)
- Period 12 disposition: execute Bill's decision (skip / backdate / partial)

Mon Jun 8:

- 17:30 PT: confirm close cron fires (ntfy publish to dr3-vision-system "container ready" earlier in the day; cron log shows close attempted)
- 17:31 PT: confirm signature-request email landed in Janette's inbox (if Period 12 was kept) or no-op (if skipped)

Tue Jun 9:

- 06:00, 07:30 PT: confirm escalation cron fires if Period 12 unsigned (else no-op)
- 08:30 PT: confirm auto-override path runs cleanly
- 09:00 PT: confirm deadline-missed ntfy does NOT fire (PDF should be in payroll inbox)

When all confirmations land, sprint addendum is shipped.

---

## Wave dispatch summary for multi-agent

| Wave                    | Tickets                                         | Parallelism notes                                                                                                                                  |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** Foundation        | T-200, T-201, T-202, T-203, T-204, T-205, T-206 | T-200 and T-201 sequential (T-201 depends on schema). T-202 large refactor, can absorb a full agent. T-203/204/205/206 parallel after T-202 lands. |
| **B** Eugene awareness  | T-207, T-208, T-209, T-210                      | Fully parallel after Wave A                                                                                                                        |
| **C** Integration tests | T-211, T-212, T-213                             | Fully parallel after Wave B                                                                                                                        |
| **D** Polish + deploy   | T-214, T-215, T-216                             | T-214 + T-215 parallel; T-216 is Bill-driven, after T-211–T-213 pass                                                                               |

Critical path is T-200 → T-202 → T-208 → T-211 → T-216. About 5 hops with parallelism.

## Risks and mitigations

| Risk                                                   | Mitigation                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema rename breaks an unmigrated test fixture        | T-200 acceptance covers `tsc --noEmit`. Any test importing the old name fails the build before deploy.                                                                                                                                                                          |
| Bill's account is unreachable when auto-override fires | T-205 includes "auto-override actor available" check in the escalation cron — if the configured actor isn't a valid active user, the cron publishes an urgent ntfy and does NOT proceed with auto-sign (better to miss the deadline with explicit alert than to fail silently). |
| Eugene chain config wrong on first cycle               | T-208 acceptance + T-212 e2e test catch this. Backup: signature chain is a single-row config; admin can fix it via SQL in under a minute.                                                                                                                                       |
| Period 12 disposition uncertainty                      | T-214 runbook explicitly lists the three options. Default if Bill doesn't decide: skip.                                                                                                                                                                                         |
| Cron timing drift across DST                           | Already handled by ADR-0019.1 — all date math goes through `@/lib/time`, which uses `Intl.DateTimeFormat` for Pacific. DST transition Mar 8 / Nov 1, 2026 verified in T-205 test cases.                                                                                         |
| Existing bookmarks to `/bonus/months/[id]` break       | URL paths preserved per ADR-0019.1 §7 — no bookmark invalidation.                                                                                                                                                                                                               |

## Out of scope (deliberate)

- Removing the `/bonus/months/[id]` URL segment. Bookmarks stay.
- Multi-site simultaneous editing UI (admins can switch sites; concurrent edits not modeled).
- Configurable auto-override time per site (08:30 PT is the universal cutoff).
- Per-site distinct mail-send recipients (still `payroll@svdp.us` for both).
- Backporting old monthly bonus data — there isn't any.
- Rick or Kelsey adding Woodland processors. Site visibility is strict.
