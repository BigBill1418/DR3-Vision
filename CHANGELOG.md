# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### 2026-06-08 — Eager historical-period PDF generation (T-321, ADR-0023)

Sprint 3 historical import: every `historical_imported` pay period now gets a
PDF generated and uploaded to R2 at seed/deploy time (ADR-0023 Q13).

- **`scripts/generate-historical-pdfs.mjs` (feat).** Enumerates every
  `historical_imported` period with a NULL `pdf_storage_key` and drives PDF
  generation via the loopback-guarded internal route (fleet `.mjs`→internal-route
  convention, mirroring `scripts/bonus-period-close.mjs`). Idempotent (skips
  periods that already have a key); logs a generated/skipped/failed summary.
  Runnable standalone (`npm run db:seed:pdfs`) per the operator runbook.
- **`POST /api/internal/bonus/generate-pdf/[id]` (feat).** Internal,
  loopback-guarded endpoint that calls the existing `generateBonusPdf` path;
  no-ops on an already-set `pdf_storage_key`.
- **Historical-aware PDF render (feat).** The internal bonus-PDF page now prints
  the **as-paid legacy total** (`legacy_total_payout_cents` when
  `imported_with_legacy_formula`, per ADR-0023 Q1) and an import-specific
  attestation ("Imported from <file> SHA-256 …, not signed by facility or ops")
  for `historical_imported` periods. The live signed-period path is unchanged.
- **Seed wiring.** `prisma/seed.mjs` runs PDF generation as its final step;
  best-effort so a bare `prisma db seed` without the running app / R2 logs a
  warning and continues rather than failing the data seed.

`tsc --noEmit` introduces zero new errors; ESLint clean on all touched files;
`pdf-data` + sign-route suites green (25 tests).

### 2026-06-07 — Login cinematic intro + post-cutover theme refresh

Added a cinematic Vision logo intro on first session load and completed the
theme refresh across all authenticated surfaces. `tsc --noEmit`, `next lint
--max-warnings 0`, and the full `vitest` suite all clean.

- **Cinematic login intro (feat).** First session load shows a ~3s Vision logo
  animation: deep-space ignition → cyan nebula bloom → eye/wordmark glow-in
  (CSS mix-blend-mode: screen) → scan-line sweep → flash → resolves into the
  login form. Once per session (persisted in `sessionStorage`), honors
  `prefers-reduced-motion`, and uses a pre-paint guard to prevent a flash on
  subsequent loads. Login logo screen-blended for seamless handoff. CSS-only,
  no JS animation library.
- **Theme consolidation.** The root body, auth surface, and shared dashboard
  components (avatar, health pill) are now dark-space/cyan, matching the
  already-themed dashboard shell. Admin audit + user-management views
  (bg-dr3-green-deep → bg-dr3-space; cards bg-dr3-space-2; text cream →
  mist, CTAs chartreuse → cyan) and all 13 bonus/\*\* pages (data tables with
  cyan headers + zebra rows, dark inputs with cyan focus rings, dark-glass
  modals; semantic states emerald/amber/red preserved for legibility). The
  operator iPad field UI (`operator/layout.tsx`) retains its high-contrast
  GREEN palette — now explicitly re-asserted so the dark root body does not
  bleed in. No dark-on-dark text: every `text-dr3-space` sits on a
  `bg-dr3-cyan` fill.

### 2026-06-06 — Sprint 2 addendum: production cutover executed + post-cutover fixes (T-216)

The bi-weekly + Eugene addendum was deployed to production CHAD-HQ and the
cutover state established. This is the execution log (the runbook is the
procedure; this records what actually happened).

**Cutover (live on `dr3_vision`):** pre-migration `pg_dump` backup taken
(`~/dr3-backups/dr3_pre-biweekly_*.dump` on CHAD); `prisma migrate deploy` applied
`20260606_bi_weekly_pay_periods` (renames + `bonus_signature_chains` + the
`skipped` state); seed loaded **52 pay-periods + 2 signature chains** (Woodland
Janette/Morena, Eugene Rick/Kelsey, Bill auto-override). The pre-existing monthly
June row + its 50 daily entries were **deleted** (operator decision — pre-cutover,
unsigned, unpaid, Period-12-era data; recoverable from the backup) because its
Jun 1–30 range overlapped the seeded bi-weekly periods and blocked the
post-seed `NOT NULL` DDL. **Period 12 skipped** on both sites; **Period 13
(Jun 9–22, pay Jun 26)** is the first canonical bi-weekly payroll period.
Consequence: no bonus daily entry is possible Jun 6–8 (those dates resolve to the
skipped Period 12); entry resumes Jun 9.

**Three bugs caught at cutover and fixed (not surfaced by tests/build):**

- **`fix(bonus-cron)` — daemons crash-looped.** `bonus-period-close` and
  `bonus-escalation-check` used `setTimeout(...).unref()`; with only that timer
  pending, Node's event loop had nothing keeping it alive, so each daemon exited
  `0` right after scheduling → container restart loop, never firing. Removed
  `.unref()` so the sleep timer keeps the process alive.
- **`fix(seed)` — assertCounts too strict for prod.** The seed asserted exact row
  counts including `users: 5`, but prod has 7 (added via the admin UI), so the
  seed aborted at validation. Seed-controlled tables keep exact counts;
  runtime-growable tables (`users` / `sources` / `transporters`) now assert a floor.
- **`chore(compose)` — false "unhealthy" on the cron containers.** Both cron
  daemons inherited the app image's HTTP `/healthz` HEALTHCHECK, which can never
  pass for a non-web process. Added `healthcheck: disable` to both cron services;
  liveness is the running process + `restart: unless-stopped`.

**Remaining operator steps:** bootstrap the Eugene processor roster via the UI
(`/bonus` → Eugene → Employees; empty by design); authed visual check (Rick sees
Bonus → Eugene; admins get the site picker).

### 2026-06-06 — Sprint 2 addendum (consolidated): bi-weekly bonus cadence + Eugene site enablement

Umbrella summary of the Sprint-2 addendum (T-201 … T-215). The per-wave entries
below carry the implementation detail; this entry is the single reconciled
overview of what the addendum delivers, for readers who don't want to reassemble
it from the wave entries.

**What it is.** Two corrections to the Bonus Management System (ADR-0019),
shipping together on the Mon Jun 8, 2026 cutover:

- **Bi-weekly cadence (ADR-0019.1, `docs/adr/0019.1-bonus-cadence-bi-weekly.md`).**
  Bonus reporting moves from monthly to **bi-weekly** — 26 periods/year, 14 days
  fixed, Tue→Mon, Friday pay date — matching the SVdP 2026 Payroll Calendar.
  Schema renamed `bonus_months → bonus_pay_periods` with site-neutral
  `facility_*` / `ops_*` signature columns, new `period_number` / `period_year` /
  `pay_date` / `*_auto_override_at` columns, and a terminal `skipped` state. The
  monthly `bonus-month-close` cron is gone; a daily Pacific-aware **17:30 PT**
  close (`bonus-period-close`) replaces it. A hard **Tue 09:00 AM PT** payroll
  deadline is enforced by the `bonus-escalation-check` cron: 06:00 warn → 07:30
  urgent → 08:30 **auto-override as Bill** → 09:00 deadline-miss check. Period 12
  of 2026 is **skipped** at cutover (admin-only `POST /api/bonus/months/[id]/skip`;
  Period 13 is the first canonical bi-weekly PDF.
- **Eugene enablement (ADR-0019.2, `docs/adr/0019.2-bonus-eugene-site-enablement.md`).**
  Eugene goes live as a second bonus site with no schema migration (already
  site-scoped). Delivered: the access matrix (Rick → Eugene only, Morena →
  Woodland only, admins → both with a site picker), a per-site
  `bonus_signature_chains` table (Eugene = Rick facility / Kelsey ops / Bill
  auto-override), PDF site-name substitution, and Vision Dashboard tile routing
  (Rick now sees the bonus tile). Both sites share the pay-period calendar and the
  `payroll@svdp.us` destination.

**Docs (T-214 / T-215).** Operator cutover runbook at
`docs/operator/bonus-cadence-and-eugene-cutover.md`; both ADRs copied into the
canonical `docs/adr/` and indexed in `docs/adr/README.md`; `README.md` and
`PROJECT-CHARTER.md` updated.

**Gates:** `tsc --noEmit` clean, `next lint --max-warnings 0` clean, full
`vitest` suite green (648 tests).

### 2026-06-06 — Sprint 2 addendum: wire `signed -> paid` on confirmed payroll delivery (T-211 step 5; closes the t4 false-alert)

Fixed the gap surfaced by the Wave C e2e tests: nothing advanced a pay period
from `signed` to `paid`, so the T-206 t4 09:00 PT deadline-miss check (keyed on
`state != 'paid'`) fired a FALSE "payroll deadline MISSED" URGENT ntfy every pay
cycle for periods that had actually delivered. `tsc --noEmit`, `next lint
--max-warnings 0`, and the full `vitest` suite (648 tests) all clean.

- **`src/lib/bonus/payroll-delivery.ts`** now advances `signed -> paid` through
  the audited state machine (`transitionMonth`, actor `system:payroll-delivered`)
  AFTER `sendPayrollPdf` returns a confirmed delivery (`delivered: true` — a real
  202 + message id). The transition fires only on real delivery: a fail-open
  no-op (`disabled: true`, M365/R2 unconfigured) or an exhausted/failed send
  leaves the period `signed`, so the t4 check still alerts on a REAL miss.
  Because both the manual 2nd-signature path and the t3 auto-override path call
  the shared `triggerPayrollDelivery`, both now reach `paid`. The new `markPaid`
  helper swallows the `paid -> paid` illegal-transition (idempotent re-fires /
  retries) and never rethrows — the mail already shipped, so a transition failure
  degrades to a t4 alert rather than crashing the background task. `paid` was
  already a valid `signed -> paid` edge in `ALLOWED_TRANSITIONS` (no schema/table
  change needed).
- **`src/lib/bonus/escalation.ts` t4** already keyed off `state != 'paid'`; with
  the transition wired it is now correct automatically — verified, no change.
- **`src/lib/bonus/__tests__/bonus-cycle-e2e.test.ts`** flips the T-211/T-212
  end-state assertions from `signed` to `paid` (T-211 step 5 implemented), drives
  the REAL delivery chain in-process (R2 + Graph mocked at the boundary), and
  adds a dedicated block proving: (a) confirmed delivery → `paid` + NO t4 false
  alert; (b) delivery failure → stays `signed` → t4 DOES fire the real
  deadline-miss; (c) fail-open (R2 unconfigured) → not `paid` (no delivery
  happened). 648 tests total (was 645).

### 2026-06-06 — Sprint 2 addendum: site-aware bonus emails + Wave C e2e tests (T-211, T-212, T-213)

Made the payroll + signature-request emails site-aware (so Eugene is no longer
mislabeled "Woodland") and added the Wave C end-to-end cycle tests. `tsc
--noEmit`, `next lint --max-warnings 0`, and the full `vitest` suite (645 tests)
all clean.

- **Site-aware email copy.** `src/lib/bonus/payroll-delivery.ts` and
  `src/lib/bonus/signature-notifications.ts` no longer hardcode "Woodland". Both
  now resolve the display name from the pay period's `site.name` (joined in the
  Prisma `select`) and strip the seeded "DR3 " prefix via
  `bareSiteName` from `@/lib/bonus/pdf-data` — the same helper T-209's PDF title
  uses. Woodland copy is byte-for-byte unchanged ("DR3 Woodland processor bonus
  …" / "Woodland processor bonus — `<ym>`"); Eugene now reads "Eugene". Tests
  extended so a Eugene period produces Eugene-labeled email and Woodland stays
  Woodland.
- **Wave C e2e tests** in `src/lib/bonus/__tests__/bonus-cycle-e2e.test.ts` (8
  tests). T-211 drives the real Woodland Period 12 close → pending_signatures
  (+ signature-request email) → Janette → partially_signed → Morena → signed
  (total locked from entries via the rule) → PDF + payroll mail, asserting every
  state transition + audit row and that the test payroll recipient got the PDF;
  Period 13 stays draft. T-212 repeats for Eugene (Rick + Kelsey) and asserts
  site isolation (no Woodland audit/state contamination; cross-site forged id
  404s). T-213 drives the escalation cron: t1 default + t2 urgent ntfy, then t3
  auto-signs both slots as the chain auto-override actor (Bill) with
  `*_auto_override_at` + the ADR-0019.1 attestation language and the
  `system:bonus-escalation` audit actor, firing the PDF/mail side-effects.
- **GAP surfaced (NOT papered over):** no production code drives the
  `signed -> paid` transition. `sendPayrollPdf` deliberately leaves the period
  `signed` and writes `payroll_sent_at`; nothing calls
  `transitionMonth(..., to: 'paid')`. So T-211 step 5 ("M365 send success →
  state `paid`") is unimplemented — the cycle ends in `signed`. The e2e asserts
  the actual end state and documents the gap. Knock-on: the t4 09:00 PT
  escalation keys off `state != 'paid'`, so a successfully-delivered period would
  still trip a FALSE "payroll deadline MISSED" alert. Needs a follow-up that
  advances `signed -> paid` on confirmed M365 delivery.

### 2026-06-06 — Sprint 2 addendum Wave B: Eugene-aware access gate + Vision tile/site-picker (T-207, T-210)

Made the bonus surface multi-site (Woodland + Eugene) per ADR-0019.2 §1/§6.
`tsc --noEmit`, `next lint --max-warnings 0`, and the full `vitest` suite
(598 tests) all clean.

- **`src/lib/bonus/access.ts` reshaped (T-207).** New
  `checkBonusAccess(session, requestedSite?): Promise<{allowed, sites}>` is the
  single source of truth for the ADR-0019.2 §1 matrix: admin → both sites;
  Woodland manager (Janette) → woodland; Eugene manager (Rick) → eugene;
  California-ops manager (Morena, `primary_site_id=null`) → woodland only (no
  Eugene); operator → denied. A `requestedSite` narrows the list and flips
  `allowed:false` when out of reach. The manager's `primary_site_id` (a uuid) is
  mapped to a site code via a single Prisma lookup — no hardcoded `'woodland'`
  site logic. `requireBonusAccess(requestedSite?)` is now site-aware: it resolves
  the EFFECTIVE site (explicit `?site=` → picked-site cookie → first allowed
  site), loads that site row, and returns a `BonusContext` carrying `siteCode`,
  `siteName`, and `allowedSites`. The old page-friendly `{ok,ctx}` variant was
  renamed `tryBonusAccess`. New helpers: `parseSiteCode`, `siteFromRequest`.
- **All bonus routes thread `?site=`.** Every `/api/bonus/**` route (and the
  `/bonus/months/[id]/pdf` route) passes `siteFromRequest(req)` into
  `requireBonusAccess`, so an admin's chosen site scopes the query and managers
  stay confined to their own site. Cross-site month access by id 404s.
- **Vision Dashboard bonus tile expanded (T-210).** `canSeeTile('bonus', …)` now
  returns true for every manager (Woodland, Eugene, California-ops) — only the
  matrix expands, the tile shape is unchanged (addendum hard rule 6). The
  `woodlandSiteId` arg is retained but no longer load-bearing.
- **Admin site picker + switch (T-210).** `/bonus` now server-detects multi-site
  access: single-site users scope straight to their site; admins with no pick yet
  get a themed site picker ("Choose a site: Woodland | Eugene"). The choice
  persists in a `dr3_bonus_site` cookie (server actions in
  `src/app/bonus/site-actions.ts`); the new `/bonus` layout shows a
  "Site: <name> | switch" banner on every bonus route for multi-site admins.
  New UI (`SitePicker`, `SiteSwitchBanner`, `layout.tsx`) matches the dark
  dr3-space/cyan theme.
- **Tests.** Rewrote `access.test.ts` for the new shape (full matrix +
  requestedSite narrowing + effective-site resolution + deny paths). Updated the
  bonus route tests and `dashboard-tiles.test.ts` to the expanded matrix (Rick
  now reaches Eugene; "Rick → 403" became "Rick requesting Woodland → 403 /
  Rick on Eugene → allowed").

### 2026-06-06 — Sprint 2 addendum Wave B: signature-chain lookup + site-aware signature service (T-208)

Made the bonus signature service site-aware by sourcing signer/override identity
from the `bonus_signature_chains` table (ADR-0019.2 §2) instead of any hardcoded
"Janette signs facility / Morena signs ops" role heuristic (addendum hard rules
#2 & #3). Woodland outcomes are unchanged — Janette/Morena are still the Woodland
signers, just sourced from the chain now. `tsc --noEmit`, `next lint
--max-warnings 0`, and the full `vitest` suite (571 tests, +28) all clean.

- **New `src/lib/bonus/signature-chain.ts`.** `getSignatureChain(siteId, db?)`
  reads the single `bonus_signature_chains` row for a site and returns
  `{facility_signer_user_id, facility_override_actor_user_ids[],
ops_signer_user_id, ops_override_actor_user_ids[], auto_override_actor_user_id}`.
  The override-actor columns are stored by the T-201 seed as comma-separated
  UUID strings; `parseOverrideActorIds()` splits/trims/drops-blanks back to
  arrays. Cached per-(db,site) for the request lifecycle via a `WeakMap` keyed on
  the db instance (failed lookups evict so a retry re-reads).
  `getAutoOverrideActor(siteId)` returns the chain's auto-override actor — never
  hardcoded as Bill. `SignatureChainNotFoundError` on an unseeded site.
- **`src/lib/bonus/signatures.ts` now chain-sourced.** `canSignSlot(user, slot,
siteId)` → `user.id === chain.{slot}_signer_user_id`; `canOverrideSlot(user,
slot, siteId)` → admin (ADR-0019.2 §3) OR `user.id ∈
chain.{slot}_override_actor_user_ids`; `naturalSlotFor(user, siteId)` resolves
  the caller's primary slot from the chain. All async now. `recordSignature`
  threads `siteId` (from the signer context) + an optional `chainDb` through to
  these. `getAutoOverrideActor` is re-exported here so the T-205 escalation cron
  has one import site.
- **Callers threaded.** Sign route passes `chainDb: prisma`; the month detail
  page computes `viewerSlot` + `overridableSlots` from the chain (scoped to the
  period's `site_id`) and now wires `overridableSlots` into `SignaturePanel`.
- **Tests.** New `signature-chain.test.ts` implements the addendum acceptance
  matrix across both sites (Rick signs Eugene facility but not Woodland; Kelsey
  signs Eugene ops, but Woodland ops is an override for her not primary; Bill
  overrides either slot at either site; Morena overrides Woodland facility but
  not Eugene ops; etc.) plus parsing/caching/error coverage. Existing
  `signatures.test.ts` / `signature-override.test.ts` / sign-route test updated
  to feed a Woodland chain double — assertions/outcomes unchanged.

### 2026-06-06 — Sprint 2 addendum Wave A: state machine period boundaries + `skipped` transition (T-203)

Converted the bonus state machine from calendar-month boundaries to the
pre-seeded bi-weekly pay-period boundaries (ADR-0019.1 §3/§6) and added the
`draft → skipped` admin-only transition (ADR-0019.1 "Bootstrapping question").
No crons here (T-204/205/206) and no Eugene access (Wave B). `tsc --noEmit`,
`next lint --max-warnings 0`, and the full `vitest` suite (543 tests, +26)
all clean.

- **Period resolution, not month math (`src/lib/bonus/state-machine.ts`).** New
  `resolveOpenPayPeriod(db, siteId, day)` returns the SEEDED period whose
  `[period_start, period_end]` window contains `day` (`period_start <= day AND
period_end >= day`), scoped by site — a pure lookup that NEVER fabricates a
  calendar-month row. `getOrCreateDraftPayPeriod` is retained as a back-compat
  alias (T-202 name freeze) and now resolves, returning `null` on a true miss.
  The month-boundary helpers (`monthStartUTC`/`monthEndUTC`) are removed.
- **`closePayPeriodsDueForSignature(db, now)`** now selects
  `WHERE period_end = appToday() AND state = 'draft'` (Pacific-aware via
  `@/lib/time`, supplied as `now` for determinism) and transitions matches to
  `pending_signatures` with actor label `system:period-close-cron`. Idempotent:
  a second same-day fire no longer matches `state = 'draft'`. This is what the
  T-204 close cron will call.
- **`draft → skipped` transition.** Single legal in-edge to the terminal
  `skipped` state added to `ALLOWED_TRANSITIONS`; `ADMIN_ONLY_TRANSITIONS` +
  `isAdminOnlyTransition()` mark it admin-only, enforced inside `transitionMonth`
  (new `TransitionForbiddenError`, 403) as a server-side backstop. A `skipped`
  period blocks daily-entry mutations (not in `EDITABLE_STATES`) and the
  signature workflow (`recordSignature` returns `wrong_state`).
- **New route** `POST /api/bonus/months/[id]/skip` — admin-only (managers 403),
  site-scoped, transitions a `draft` period to `skipped`.
- **Daily-entry layer** (`src/lib/bonus/daily-entry.ts`) now resolves the seeded
  period by range and raises `NoOpenPayPeriodError` (409) when no seeded period
  covers the day, surfaced cleanly by the entries route and the `/bonus` page
  (instead of fabricating a row or 500ing).

### 2026-06-06 — Sprint 2 addendum Wave A foundation: bi-weekly cadence schema + seed (T-200, T-201)

Foundation for the monthly→bi-weekly bonus cadence (ADR-0019.1) and Eugene
site enablement (ADR-0019.2). Schema + seed only; the TypeScript-wide rename
refactor is T-202 (still pending — `tsc --noEmit` reports 30 expected
old-name errors confined to the 10 bonus/m365 files T-202 will update).

- **T-200 — schema migration.** New migration
  `prisma/migrations/20260606_bi_weekly_pay_periods/` renames `bonus_months`→
  `bonus_pay_periods` in place (preserving OIDs/FKs), renames the boundary
  columns (`month_start`→`period_start`, `month_end`→`period_end`), the
  signature columns (`janette_*`→`facility_*`, `morena_*`→`ops_*`), the enum
  (`BonusMonthState`→`BonusPayPeriodState`, plus a new terminal `skipped`
  value for the Period 12 bootstrap), and the `bonus_daily_entries` FK
  (`bonus_month_id`→`bonus_pay_period_id`). Adds `period_number` /
  `period_year` / `pay_date` (NULL-allowed; tightened post-seed), the
  `*_auto_override_at` timestamps, a `pay_date` index, and the new
  `bonus_signature_chains` table (per-site signer/override config). A
  hand-applied `down.sql` reverses the renames for emergency rollback (not run
  by Prisma migrate). `prisma/schema.prisma` updated to match; client
  regenerated with `BonusPayPeriod`, `BonusPayPeriodState`,
  `BonusSignatureChain`. Verified end-to-end against a throwaway Postgres 16
  (all 7 migrations apply cleanly via `prisma migrate deploy`).
- **T-201 — pay-period + signature-chain seed.** Two new CSVs in
  `prisma/seed/` (`bonus_pay_periods_2026.csv` = 26 periods × 2 sites = 52
  rows; `bonus_signature_chains.csv` = Woodland + Eugene). `prisma/seed.mjs`
  gains `seedBonusPayPeriods()` (idempotent on `site_id`+`period_year`+
  `period_number`), `seedBonusSignatureChains()` (idempotent on `site_id`,
  resolves signer/override EMAILS to user ids at seed time), and a post-seed
  DDL step (NOT NULL on the period-identity columns + the canonical unique
  index). `assertCounts()` now also asserts `bonus_pay_periods=52` and
  `bonus_signature_chains=2`. Verified on the scratch DB: 52 + 2 rows, Eugene
  Period 13 reads `period_start=2026-06-09 / period_end=2026-06-22 /
pay_date=2026-06-26`, signature chains resolve to the correct people
  (Woodland: Janette/Morena, overrides Bill+Morena / Bill; Eugene: Rick/Kelsey,
  overrides Bill+Kelsey / Bill; auto-override Bill at both), and re-running the
  seed is a no-op.
- **Signer-email reconciliation (flagged, not silently absorbed).** The
  provided `bonus_signature_chains.csv` identified signers by emails that did
  not all match the seeded `users.csv`. The three short-form addresses
  (`janette@`/`morena@`/`rick@`) are logged with a warning during seed-time
  email resolution; the full mapping is visible in the ADR-0019.2 final appendix.
