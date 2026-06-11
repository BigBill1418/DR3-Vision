# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### 2026-06-11 — Fix: manager bonus UI shows the SITE's signers (no hardcoded Woodland names)

The manager-facing bonus UI hardcoded the WOODLAND signature-chain names, so a
**Eugene** pay period rendered **Janette Tomas / Morena Gomez** (the Woodland
facility/ops signers) instead of Eugene's **Rick Albritton / Kelsey Ruhland**.
Kelsey — reaching Eugene via the ADR-0024 `all_sites` flag — opened a Eugene
report and saw the wrong signers. Ground truth (who signs which slot at which
site) lives in the `bonus_signature_chains` data; the data layer was already
site-scoped everywhere, and the **bonus-pdf page already resolved names from the
chain correctly** — only these three presentation surfaces lagged. This violated
CLAUDE.md **hard rule #2** (Eugene and Woodland are strictly separated; no
per-site signer identity is baked into presentation). The hardcoded literals
predate ADR-0024 — `all_sites` simply gave Kelsey the cross-site reach that
exposed the latent defect.

**Root cause:** three presentation surfaces carried `"Janette Tomas"` /
`"Morena Gomez"` (and `Janette`/`Morena` short forms) as literals rather than
resolving the period's signature chain.

**Fix (presentation only — no data-layer or authority change):**

- **`src/app/bonus/months/[id]/page.tsx`** — resolves the period's signers from
  the chain via a new shared helper and passes the names to both signature cards
  and the signature panel. "Awaiting signature" logic untouched.
- **New `src/lib/bonus/signer-names.ts`** (`resolveSlotSignerNames`) — lifts the
  exact chain-resolve-then-`user.findMany` pattern the bonus-pdf page already
  uses into one unit-testable helper, so the page and panel share one
  implementation. Falls back to the user UUID if a name is unresolved (same as
  the PDF page).
- **`src/app/bonus/months/[id]/SignaturePanel.tsx`** — module-level
  `SLOT_LABEL` / `SLOT_ASSIGNEE` constants replaced with `facilityAssignee` /
  `opsAssignee` props (chain-resolved by the page); labels, the "Sign on behalf
  of …" link, and the override-reason placeholder now build from props.
  Server-side signature authority (already chain-sourced) is untouched.
- **`src/lib/bonus/month-list.ts` + `src/app/bonus/months/page.tsx`** — the list
  view's `janetteSigned` / `morenaSigned` fields renamed to slot-neutral
  `facilitySigned` / `opsSigned`, and the partial-signature label is now
  slot-generic ("Facility signed" / "Ops signed") rather than a (wrong-for-
  Eugene) signer name. The list intentionally does **not** resolve per-row chain
  names (would N+1 the query); the detail page resolves identity.

**Tests (+14, suite 720 → 734 green):** new `signer-names.test.ts` (Eugene →
Rick/Kelsey, Woodland → Janette/Morena, no-leak, UUID fallback, single
`user.findMany`); new `SignaturePanel.test.tsx` (site-aware labels + override
copy via static markup); extended `month-list.test.ts` (`facilitySigned` /
`opsSigned`, slot-neutral `signatureLabel`). `tsc` 0, ESLint 0. Vitest config
pins the React 18 automatic JSX runtime so client components render to markup in
tests (tsconfig `jsx: preserve` otherwise leaves no runtime).

**Deploy verified live (2026-06-11 ~8:30 PM PDT / 03:30 UTC):** PR #21 merge
`1edacc8` auto-deployed by swarmpilot_deployer to CHAD-HQ — clean warm-cache
build (~9.5 min, under the 900s `compose_build_timeout` from noc-master
ADR-0105), container recreated healthy, no manual rebuild needed. In-bundle
verification: the new slot-neutral "Facility signed" label is present in the
running `.next` output and the old `"Sign as Facility Manager (Janette)"`
literal is absent.

### 2026-06-09 — Ops: DR3 deploy build timeout raised + first escalation-run verification scheduled

Two operational follow-ups to the go-live-day escalation fixes (ADR-0025):

- **Deployer build timeout 600 s → 900 s for DR3-Vision.** The fleet
  auto-deployer (`swarmpilot_deployer`) capped remote builds at 600 s; CHAD-HQ's
  cold Next.js build for `dr3-vision-app` (multi-stage + Playwright/chromium) runs
  right at/over 10 min, so a cold deploy SIGKILL-aborted and only a warm-cache
  build squeaked under. Fixed in **noc-master ADR-0105** (per-repo
  `compose_build_timeout: 900` for DR3 only; all other repos unchanged). Cold DR3
  deploys now have headroom; the manual-build workaround should no longer be needed.
- **First production escalation-run verification scheduled.** A one-shot
  host monitor on CHAD-HQ (`~/dr3-escalation-monitor.sh`, systemd `--user` timer,
  fires 2026-06-10 16:10 UTC / 09:10 PT — after the 09:00 PT t4 tier) checks the
  first real scheduled run of the ADR-0025-hardened escalation: all four tiers
  executed, **no** ntfy publish `dropped` (PR #17 retry), and **no** t4 false-fire
  (PR #18 — and the DB confirms 0 periods end "yesterday" Jun 9, so a correct run
  examines nothing). It ntfys Bill a PASS/WARN/FAIL verdict and writes
  `~/dr3-escalation-monitor-20260610.md`.

### 2026-06-09 — Fix: t4 payroll-deadline escalation no longer false-fires on archival periods

The 09:00 AM PT `t4` "payroll deadline missed" escalation queried
`bonus_pay_periods` with `state != 'paid'`, so any **non-paid** period whose
`period_end` was yesterday matched — including terminal/archival periods that are
not live deadlines. On the **2026-06-09 go-live** this flagged **Period 12
(eugene + woodland)**, both `historical_imported` (ADR-0023 spreadsheet loads,
already paid in V1) and ending Mon Jun 8, as two missed payroll deadlines.

**Fix:** `runDeadlineMissed` now uses an allowlist of the _live_ pre-`paid`
lifecycle states — `draft`, `pending_signatures`, `partially_signed`, `signed`
(`T4_LIVE_DEADLINE_STATES` in `src/lib/bonus/escalation.ts`). The archival/terminal
states — `paid` (success), `skipped` (pre-cutover empties), `historical_imported`
(ADR-0023), and `amended` (admin corrections) — are excluded. `draft` stays in
the list so a period that never closed (period-close cron failed) still pages.
t1–t3 were already allowlisted (`pending_signatures`/`partially_signed`), so only
t4 carried the leak.

TDD: 4 new cases in `escalation.test.ts` (no fire on `historical_imported` /
`skipped` / `amended`; still fires on `draft`). Existing t4 cases (`signed`,
`paid`, `pending_signatures`) unchanged. Full suite 720 green; `tsc --noEmit` 0;
eslint 0.

### 2026-06-09 — Resilience: retry ntfy publishes so a transient blip can't drop an alert

`publishNtfy` (`src/lib/ntfy.ts`) now retries each delivery path with short
backoff instead of taking a single shot at the primary and a single shot at the
fallback. Previously one momentary network hiccup on CHAD-HQ would lose the
alert entirely.

**Why:** on the 2026-06-09 Period-13 go-live, the 09:00 AM PT (`t4`) bonus
escalation correctly detected two periods and tried to page, but the publish was
logged `dropped (primary+fallback failed)` — both the primary
(`ntfy.barnardhq.com`) attempt and the immediately-following `ntfy.sh` fallback
attempt failed within ~16 ms of each other (an instant connection error, not a
5 s timeout — i.e. a transient egress blip). The helper had no retry, so for a
`t4` deadline-missed alert — which has no later tick that day — the page was
simply lost. (No impact on go-live day: the period had just _opened_, so there
was no real deadline to miss. This hardens the path for real future deadlines.)

**What changed:**

- New `postWithRetry` wrapper. Primary does up to **3 attempts** (backoff
  250 ms / 750 ms); fallback does up to **2 attempts** (backoff 500 ms). A
  transient failure returns instantly, so a retry costs ≈ the backoff, not a
  full timeout.
- A shared **`PUBLISH_TOTAL_BUDGET_MS` (12 s)** wall-clock budget across all
  attempts so a genuinely hung server can never block a caller far past it — the
  pathological all-timeout case stays bounded.
- Cooldown is still recorded on a retry-recovered success, so recovery can't
  double-page. No change to _what_ is published or to ADR-0036/0037 semantics
  (topics, headers, cooldowns, the obscured fallback topic) — delivery
  resilience only.
- TDD: 3 new cases in `ntfy.test.ts` (transient-blip recovers as `sent` without
  touching the fallback; `dropped` only after all 5 attempts fail; cooldown
  recorded after a retried success). Existing fallback/no-fallback cases updated
  for the new attempt counts. Suite 716 green; `tsc --noEmit` 0; eslint 0.

### 2026-06-09 — Observability: log denied Entra sign-ins (email + reason)

`evaluateEntraSignIn` now emits a structured `log.warn` on every denial —
`{ event: 'entra_signin_denied', email, reason }` — where `reason` is one of
`no_email | unknown | inactive | deleted | wrong_role` and `email` is the
attempted (lowercased) address (or `null` when none was presented). Previously a
rejected sign-in surfaced only as an opaque Auth.js `AccessDenied` with no record
of who was denied or why, which is exactly what made the `janette.tomas@` typo
(her row said `janette.thomas@`) so slow to diagnose. The email is an identifier,
not a secret (unlike `pin_hash`), so it is safe and necessary to log for support.
The logs ship to Loki via the existing pino → Alloy pipeline. TDD: 4 new cases in
`auth.signin-gate.test.ts` (logs each denial reason with the attempted email;
silent on success).

Janette Tomas (Woodland facility manager) could not sign in: her DR3 user row and
the seed data had her surname misspelled **Thomas**, so the email/UPN Microsoft
presents (`janette.tomas@svdp.us`) didn't match the seeded `janette.thomas@svdp.us`
— the Entra sign-in gate looked her up, found nobody, and returned `AccessDenied`.

- **Live prod fixed first** (direct DB update): her `users` row is now
  `janette.tomas@svdp.us` / `Janette Tomas`. Her Woodland facility-signer slot
  followed automatically (the signature chain references her by user-id, not email).
- **Source fixed** so a future re-seed can't reintroduce the typo (which, because
  the seed upserts by email, would have created a _duplicate_ wrong-Janette):
  `prisma/seed/users.csv`, `prisma/seed/bonus_signature_chains.csv` (Woodland
  facility signer), and the historical-import alias map in `prisma/seed.mjs`.
- **Name corrected** in the bonus month-detail signature card (`/bonus/months/[id]`),
  the README / charter / seed README, the operator cutover runbook, and the bonus
  test fixtures. (Immutable ADRs + superseded draft docs left as historical record.)

`tsc --noEmit` exits 0; the touched bonus suites stay green.

### 2026-06-09 — All-sites manager: `/admin/users` toggle (ADR-0024 follow-up)

Granting/revoking `all_sites` no longer requires a seed change or raw SQL — it is
now a checkbox in the admin user panel, closing the follow-up noted when the flag
shipped earlier today.

- **UI.** A manager-only **"Access to all sites"** checkbox on both the create
  (`/admin/users/new`) and edit (`/admin/users/[id]`) forms. It renders only when
  role is `manager` (meaningless for admins, who already see all sites, and for
  operators, who are single-site). The users list shows an **"All sites"** badge
  in the site column for flagged managers.
- **API + model.** `all_sites` accepted on `POST /api/admin/users` and the
  `update` action of `PATCH /api/admin/users/[id]`. `createUser` / `updateUser`
  **coerce it to false whenever the effective role is not `manager`** — so
  promoting an all-sites manager to admin, or demoting to operator, clears the
  flag automatically. The flag is part of the append-only audit before/after
  snapshot (`AuditableUser`).
- **Tests.** TDD: 4 new route cases (create manager with the flag; create
  operator coerces it false; toggle on an existing manager; promote-to-admin
  clears it).

**Tests:** full `vitest` suite green (**710**); `tsc --noEmit` exits 0; ESLint
clean.

### 2026-06-09 — All-sites manager (ADR-0024)

New `all_sites` flag on `users`: when set on a **manager**, they reach **every
site** like an admin would, but the role stays `manager` so they get **none** of
the admin powers (user management, bonus amendment/override, `/admin/*`). This
splits "view all sites" from "administer the system," which the app previously
conflated into the `admin` role. Provisioned for **Kelsey Ruhland** (Data &
Compliance lead / MRC SME) so she sees both Eugene + Woodland without being an
admin.

- **Schema + migration.** `20260609_all_sites_manager`: `users.all_sites
BOOLEAN NOT NULL DEFAULT false`. Pure DDL; every existing row unchanged.
- **Session threading.** `all_sites` flows DB → Entra sign-in gate
  (`evaluateEntraSignIn`) → JWT → session (`src/lib/auth.ts`,
  `auth.config.ts`, `next-auth.d.ts`). Operators are hard-coded `all_sites:
false`.
- **Site-reach gates (the only places it is consulted).** `checkBonusAccess`
  (admin OR `all_sites` → both sites), `requireManagerForSite` (manager passes
  if `primary_site_id === site` **or** `all_sites`), the three
  `/dashboard/[site]/**` page guards, and the `/dashboard` + `/dashboard/exports`
  site pickers.
- **Admin boundary untouched.** `requireAdmin` (`/admin/*`, user management,
  audit admin) and the admin-only bonus state transitions (amendment, override)
  still gate on `role === 'admin'` — `all_sites` is never consulted there.
- **Seed.** `users.csv` gains an `all_sites` column; Kelsey is now
  `role=manager, all_sites=true` (was `admin`). CLAUDE.md hard-rule #2 + the ADR
  index updated.
- **Tests.** TDD: 8 new cases across `bonus/access.test.ts` (all-sites manager →
  both sites; narrows to either) and the new `auth-helpers.test.ts` (off-primary
  site allowed with the flag; plain manager still 403; operator still 403).

**Tests:** full `vitest` suite green (**706**); `tsc --noEmit` exits 0; ESLint
clean. **Follow-up:** an `/admin/users` toggle for `all_sites` (granting is
seed/SQL-managed until then). See ADR-0024.

### 2026-06-09 — Period-13 production go-live: bonus UX, init reaper, historical-PDF hotfix, staff activation

**Headline.** DR3-Vision's Bonus Management System went **live in production on
CHAD-HQ for the Tuesday 2026-06-09 Period-13 go-live**. The 17-month historical
import (ADR-0023) is reconciled on the live `dr3_vision` database — **$113,776.00
to the cent, 104 pay periods (76 `historical_imported`, Period 13 the first live
draft), 5,158 daily entries, 94 processors, 76/76 historical PDFs in R2** — and
the five confirmed M365 staff (Kelsey, Morena, Rick, Janette, Patrick) sign
straight in through the Entra gate. Shipped as
PR #10 (`85b2904`, historical-PDF hotfix), PR #11 (`5ba1ed8`, bonus UX + init
reaper), and a `[skip-deploy]` seed commit (`beb2ca9`, staff activation). Full
`vitest` suite green (**698**); `tsc --noEmit` exits 0; ESLint clean; `next build`
OK.

#### 2026-06-09 — Confirmed-staff activation (seed `users.csv`, `beb2ca9` `[skip-deploy]`)

Bill confirmed the production roster + emails on 2026-06-09 and that anyone in the
M365 group should sign straight in. `prisma/seed/users.csv` now seeds
**kelsey** (admin), **rick** (Eugene), **janette** (Woodland),
**morena** (Woodland, pinned explicitly rather than relying on the
`null → woodland` special case), and **patrick** (Eugene) as `is_active=true`, so
the Entra SSO gate admits them without per-person manual activation.
`operations@` stays inactive (it is an import alias, not a login). Already applied
to the live prod DB.

#### 2026-06-09 — Bonus UX: findable history, Manage Employees, Pay-Period nomenclature, date-picker hint (PR #11)

- **Findability (fix).** `/bonus` now surfaces prominent **"Manage Employees"**
  and **"Pay Period History"** buttons. History was previously unreachable from
  the entry screen — the operator could not find it.
- **Nomenclature (fix).** "month" → **"Pay Period"** across the close button,
  footer, and history page. The period label is now derived from the period
  number + window (e.g. **"Pay Period 13 · Jun 9–22, 2026"**) instead of the
  misleading calendar-month name the bi-weekly schema inherited.
- **Date-picker hint (fix).** `AdminDatePicker` now states the `max=today` rule
  explicitly (no future-day entry).

#### 2026-06-09 — init reaper: zombie chromium/Playwright reaping (PR #11)

`docker-compose.yml` sets **`init: true`** on the `app` and `cron` services so a
real PID-1 reaps Playwright/chromium child processes. The Node process had been
running as PID 1 with no init, so chromium children orphaned on exit — the 76-PDF
historical backfill leaked ~150 zombie processes. The Tini init shim now reaps
them; the prior workaround (app restart to clear zombies) is retired.

#### 2026-06-08 — Historical-period PDF render hotfix: `resolveRuleForHistorical` (T-321 hotfix, PR #10)

`historical_imported` periods (Jan 2025+) can start **before** the earliest
`processor_bonus_rules.effective_date`, so `resolveActiveRule` threw
`NoActiveRuleError` → the internal bonus-PDF page errored → the Playwright
`page.goto` timed out → **0/76 historical PDFs generated**. New
`resolveRuleForHistorical` (`src/lib/bonus/daily-entry.ts`) falls back to the
site's **earliest** rule for `historical_imported` periods only; the displayed
total is the stored as-paid legacy total (ADR-0023 Q1) and the rows are
informational, so the fallback rule never affects a payout figure. **Live periods
stay strict** (`resolveActiveRule` unchanged). User-facing month-list views were
already graceful (they catch `NoActiveRuleError`). After the fix, all 76/76
historical PDFs regenerated into R2. `daily-entry.test.ts` covers the fallback +
the live-strict path.

### 2026-06-08 — Sprint 3: historical bonus data import + Mail.Send + GlitchTip (ADR-0023)

**Headline.** 17 months of historical bonus data (Jan 2025 → Jun 2026) land in
Vision ahead of the Tue 2026-06-09 Period-13 production go-live: **5,158 daily
entries, 94 unique processors, $113,776.00 reconciled to the cent**. Delivered as
a one-shot, SHA-256-idempotent seed (no bulk-upload UI — design pivot per Q19/Q20).
Verified end-to-end against a throwaway Postgres 16: full migration chain +
`seedHistoricalImport` produce exactly 104 pay periods / 76 `historical_imported` /
94 employees / 128 aliases / 1 import / 5,158 entries / 5,234 audit rows, and
`SUM(legacy_total_cents) = 11,377,600¢ = $113,776.00` exactly; a re-run is a no-op.

- **Schema + migration (T-300).** `20260608_historical_data_import`: enum value
  `historical_imported`; dual-total (`legacy_total_payout_cents`,
  `imported_with_legacy_formula`) + `import_session_id` on `bonus_pay_periods`;
  `mattress_count` `Int → Decimal(5,1)`; provenance (`legacy_total_cents`,
  `import_session_id`, `import_provenance` JSONB) on `bonus_daily_entries`; new
  `bonus_imports` (SHA-256 idempotency key) and `bonus_employee_aliases` tables.
- **State machine (T-310).** Admin-only `draft → historical_imported` and
  `skipped → historical_imported`; amendable out-edge `historical_imported →
amended`. `historical_imported` is intentionally **not** in `EDITABLE_STATES`
  (correct via the existing admin amendment workflow only).
- **Seed runtime (T-320).** `seedHistoricalImport()` in `prisma/seed.mjs`
  (idempotent by `source_sha256`); 7 historical CSVs + the archived source
  workbook under `prisma/seed/historical/`; `assertCounts()` expanded.
- **Governance + access (T-301/T-302/T-312).** ADR-0023 shipped; Patrick Dills
  seeded (manager @ Eugene, seed-inactive, **not** a Eugene signature-chain
  member — separation of duties; he is also a `BonusEmployee` there). Tests
  assert his Eugene-scoped read access and that a sign attempt is rejected.
- **Dashboard (T-311).** Bulk-upload tile removed (Q20 — import is one-shot).
- **Decimal entry (T-330).** Daily-entry input + **both** write paths
  (`/api/bonus/entries` and the amendment route `…/months/[id]/entries`) accept
  one decimal place via the shared `isValidMattressCount` contract; the >200
  soft-warn applies on the integer floor; `mattress_count` Decimal→number
  reconciled at all read boundaries so `tsc --noEmit` is clean branch-wide.
- **Observability + payroll (T-123 / T-122).** Both are **operator env config**,
  not code flips: GlitchTip already captures 100% of errors when `GLITCHTIP_DSN`
  is set (error `sampleRate` was never 0), and M365 Mail.Send is fully env-driven
  with no sandbox lock. `.env.example` updated; an admin-gated
  `/api/admin/_test-error` route added for ingest verification.

**Tests:** full `vitest` suite green (**695**); `tsc --noEmit` exits 0; ESLint
clean. **Operator action required on CHAD-HQ** (env vars only — see the M365 and
observability operator docs): `AUTH_MICROSOFT_ENTRA_ID_*` + `M365_MAIL_FROM_ADDRESS`
/ `M365_PAYROLL_TO_ADDRESS`, and `GLITCHTIP_DSN` / `NEXT_PUBLIC_GLITCHTIP_DSN`.

Detail for the larger sub-areas follows:

#### 2026-06-08 — GlitchTip error-capture production readiness (T-123, ADR-0022)

Sprint 3: production wiring for GlitchTip error reporting. No sample-rate code
change was warranted — the error sample rate was **never pinned to 0**.
`glitchTipInitOptions()` (`src/lib/observability/sentry.ts`) sets only
`tracesSampleRate: 0` (Tempo owns traces, ADR-0022 §1) and omits the error
`sampleRate`, which the Sentry SDK defaults to `1.0`. So when `GLITCHTIP_DSN`
is set, 100% of errors are already captured; when it is unset, init no-ops
(fail-open). Production wiring is therefore **operator env config**, not a code
change.

- **GlitchTip ingest verification endpoint (feat).** New admin-gated
  `GET /api/admin/_test-error` deliberately throws so an operator can confirm
  end-to-end ingest after setting `GLITCHTIP_DSN` on CHAD-HQ. Gated to
  `role=admin` (an open error-trigger is an abuse/DoS vector): anonymous → 401,
  non-admin → 403, admin → deliberate 500 captured by GlitchTip. Closes the
  long-standing gap where `docs/operator/fleet-observability-setup.md` step 7a
  referenced an `/api/_test-error` route that was never shipped.
- **Operator runbook (docs).** Step 7a now points at the real admin-gated path
  and documents the admin-session-cookie requirement.

**Operator action (CHAD-HQ):** add `GLITCHTIP_DSN` (and the browser-side
`NEXT_PUBLIC_GLITCHTIP_DSN`, plus `GLITCHTIP_AUTH_TOKEN` for source maps) to
`~/.dr3-vision-secrets/observability.env` and recreate the container. No code
deploy is required for capture to begin. Vars are already documented in
`.env.example`.

#### 2026-06-08 — Decimal daily-entry input + Decimal migration type debt (T-330, ADR-0023)

Sprint 3: the daily mattress-count entry now accepts one decimal place, and the
`mattress_count` `Int → Decimal(5,1)` migration (Unit 1) is fully reconciled so
`tsc --noEmit` is clean branch-wide.

- **Decimal daily-entry input (feat).** `DailyEntryGrid` accepts `\d{1,4}(\.\d)?`
  — 0–999 with an optional single decimal place; `23.5` persists verbatim,
  `23.55` and negatives are rejected. A persistent "Up to one decimal place" hint
  sits under each input (wired via `aria-describedby`). The >200 soft-warn now
  fires on the **integer floor** (`200.5` → no warn; `230.5` → warn), matching the
  calculator, which floors — so a fractional entry's live bonus preview equals its
  integer-floor result.
- **Validation contract (feat).** New exported `isValidMattressCount()` in
  `daily-entry.ts` is the single source of truth (finite, 0–999, ≤1 decimal). The
  data-layer pre-check and the `POST /api/bonus/entries` zod schema both use it;
  the API rejects two-decimal / negative counts with 422.
- **Decimal → number read boundaries (fix).** `mattress_count` is converted via
  `.toNumber()` at every point where Prisma data feeds `number`-typed calculator
  inputs / view models (`bonus/months/[id]` page, `aggregates.ts`,
  `daily-entry.ts`, `month-list.ts`, and the bonus-PDF page — which replaces an
  unsafe `as PdfEntry[]` cast with a proper map). `mattress_count` stays `Decimal`
  only at the Prisma edge; downstream interfaces remain `number`.
- **Enum label maps (fix).** `historical_imported` added to both the status-label
  and badge-style maps on the bonus-months list page (muted style, matching
  `skipped`).
- **Tests.** DB-free Prisma mocks now model `mattress_count` as `Prisma.Decimal`
  (matching production reads); added decimal-contract cases at the data layer and
  the API (`23.5` accepted, `23.55`/`-3` rejected, floor equivalence). The schema
  test's state-enum assertion was intentionally updated from seven → eight states
  (`historical_imported`).

`tsc --noEmit` exits 0 (headline gate for the branch); full vitest suite green
(686 tests); ESLint clean on all touched files.

#### 2026-06-08 — Eager historical-period PDF generation (T-321, ADR-0023)

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
