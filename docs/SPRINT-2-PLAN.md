# Sprint 2 plan

**Theme:** Bonus Management System cutover, Vision Dashboard launch, full fleet observability.

This sprint ships ahead of all V2.1 backlog work. Tickets are organized into **waves** for multi-agent dispatch — tickets in the same wave have no inter-dependencies and may execute in parallel. Each wave gates the next.

Sprint 1 used T-001 through T-019. Sprint 2 uses T-100 through T-124 to give clean separation. Mark `[x]` as you complete. Do not reorder.

## Wave A — Foundation (parallel)

These tickets create the schema, fix the formula, and lay groundwork. Multi-agent dispatch can run all four in parallel.

### [x] T-100: Schema migration — bonus tables

Add `bonus_employees`, `bonus_daily_entries`, `bonus_months` per ADR-0019. Full Prisma DSL in `prisma/schema.prisma.bonus.patch`. Generate migration with `npx prisma migrate dev --name bonus_tables`.

**Acceptance:**

- `npx prisma migrate dev` applies cleanly against a Sprint-1 baseline database
- All three tables present in `prisma studio` with correct columns, indices, and unique constraints
- Migration is reversible via `prisma migrate reset` then re-apply
- `prisma generate` produces typed client; type tests in `src/lib/__tests__/bonus-schema.test.ts` confirm shape

### [x] T-101: Processor bonus rules — off-by-one correction

Update `prisma/seed/processor_bonus_rules.csv` Woodland row: `threshold_high` from `75` to `74`. Add a SQL migration that updates any existing rule row in-place (no rule row should exist yet in production, but the migration is defensive).

**Acceptance:**

- Seed CSV reflects the corrected formula
- Migration runs idempotently against a seed-loaded database
- Walk-through test: `calculateDailyBonus(50)` returns `$0.00`; `calculateDailyBonus(74)` returns `$12.00`; `calculateDailyBonus(75)` returns `$12.75`; `calculateDailyBonus(100)` returns `$31.50`
- ADR-0011 has a "Superseded by ADR-0019 §1" header added; the historical decision text stays intact

### [x] T-102: OpenTelemetry SDK + auto-instrumentation

Wire the OTel SDK into `src/instrumentation.ts` (extending, not replacing, the existing ntfy logic). Tempo exporter. Default Node auto-instrumentations except fs and dns (noisy).

**Acceptance:**

- Production build emits traces to Tempo
- Local dev build emits to a local OTLP endpoint if `TEMPO_ENDPOINT` set, otherwise no-ops
- Service name, version (from `GIT_SHA`), environment all visible in trace attributes
- A test request to `/healthz` produces a visible trace in Tempo via the fleet's Grafana UI

### [x] T-103: GlitchTip Sentry SDK integration

Wire `@sentry/nextjs` against the GlitchTip DSN. Three config files at repo root (`sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`). Scrub sensitive headers/cookies in `beforeSend`.

**Acceptance:**

- A forced `throw new Error('test')` in a server route appears in GlitchTip within 30 seconds
- The error has a meaningful stack trace (source maps uploaded for production builds with `GLITCHTIP_AUTH_TOKEN` set)
- `authorization`, `cookie`, and PIN-related events are scrubbed/dropped
- No errors appear in GlitchTip when `GLITCHTIP_DSN` is unset (fail-open)

## Wave B — Bonus core + observability + landing (parallel after Wave A)

### [x] T-104: Bonus employees CRUD

Create `/bonus/employees` for Janette (Woodland manager scope). Server-rendered list, sortable by name + status (active/inactive). Add/edit/deactivate forms.

Schema integration: when adding an employee whose name matches a deactivated record, prompt "Reactivate {name} (deactivated {date})?" with default = reactivate. Per ADR-0019 §9a.

Name change handling: editing `full_name` retroactively updates the in-portal display (per ADR-0019 §9b). The previous name appends to `previous_names` JSONB; the audit log records the before/after.

**Acceptance:**

- Janette can add Maria Lopez; she appears active
- Janette can deactivate Maria; she still appears in the inactive filter
- Janette can rename Maria Lopez to Maria Garcia; the previous-names JSONB records the old name with timestamp
- Re-adding Maria Lopez (after deactivation) prompts the reactivate flow correctly
- Rick (Eugene manager) gets 403 on `/bonus/employees`
- All audit log rows for these operations capture actor + before/after

### [x] T-105: Bonus daily entry UI

Create `/bonus` daily entry grid. Default view: today, current month, active employees sorted alphabetically. Each row: employee name, integer input (0–999, soft warn >200), optional note field. Live totals at the top tick as entries are made.

The bonus calculation pulls from `processor_bonus_rules` for the current effective date — no hardcoded math in the UI.

Per ADR-0019 §4, the keying user is captured in `entered_by_user_id`. Janette, Morena, or Bill can each key entries.

**Acceptance:**

- Janette opens `/bonus` mid-day, sees today's row pre-loaded with active employees
- Typing a count immediately updates the per-row bonus display and the page-total
- Saving persists `bonus_daily_entries` rows with the correct `entered_by_user_id`
- Morena and Bill can also key entries; the audit log differentiates
- Past day entries are editable until the month transitions to `pending_signatures`
- The note field accepts arbitrary text; it does NOT affect bonus math

### [x] T-106: Monthly state machine

Implement the BonusMonth lifecycle: `draft` → `pending_signatures` (on month-end) → `partially_signed` (one signature) → `signed` (both signatures) → `paid` (PDF delivered) → optionally `amended` (admin reset).

State transitions are server-enforced via an `ALLOWED_TRANSITIONS` table (similar to T-006's load workflow guard). Direct DB writes are forbidden — all transitions go through `src/lib/bonus/state-machine.ts`.

Daily-entry mutations are blocked once state ≠ `draft`. PDF generation is blocked unless state = `signed` (or amending). Mail-send is blocked unless state = `signed` (and `payroll_sent_at` IS NULL or amending).

**Acceptance:**

- A `draft` month auto-transitions to `pending_signatures` at midnight Pacific on the 1st of the next month
- Daily entries cannot be modified once the month leaves `draft` (server returns 409)
- A non-admin attempting to skip a state (e.g., `draft` → `signed` directly) returns 403
- The audit log captures every state transition with actor, before, after
- Tests in `src/lib/bonus/state-machine.test.ts` cover every valid + invalid transition

### [x] T-107: Vision Dashboard tile landing

Implement `/` route as the Vision Dashboard per ADR-0020. Replaces the current `src/app/page.tsx` "coming soon" placeholder.

Components:

- `src/app/page.tsx` — server-rendered, role-aware tile grid
- `src/app/_components/vision-shell.tsx` — branded shell wrapper (header, watermark, footer)
- `src/app/_components/vision-tile.tsx` — single tile (active and disabled variants)
- `src/lib/dashboard-tiles.ts` — `canSeeTile(session, tile)` logic + tile registry

The tile registry is a single TypeScript array of tile configs (label, icon, route, status, role-scope). Adding a future tile is one new entry.

Brand: DR3 green deep `#00524C` shell background, large faded "DR3" watermark in the bottom-right corner (use the actual logo SVG when Bill provides it; placeholder typographic treatment otherwise), cream `#FCFFD7` tile fills, chartreuse `#EFFE8B` accent on the featured Bonus Management tile.

**Acceptance:**

- Bill (admin) sees all six active tiles + six Coming Soon tiles
- Janette sees Bonus Management + Operations + Compliance + Reconciliation + Exports (no Admin)
- Rick sees Operations + Compliance + Reconciliation + Exports (no Bonus, no Admin)
- Operator PIN flow at `/operator` is unaffected (route group separation preserved)
- Visual matches the approved mockup (DR3 brand, heavy visual elements, Inter typography, generous spacing)
- The Bonus Management tile has the "NEW" pill in chartreuse-on-deep-green

### [x] T-108: Loki structured logging

Wire `pino` as the application logger. Create `src/lib/observability/logger.ts`. Add `request_id` correlation in `src/middleware.ts`. Document the convention in `docs/adr/0022-fleet-observability-wire-in.md` (already done — this ticket implements it).

Don't bulk-convert existing `console.log` calls. Convert as they're touched. Mark with a `// TODO(T-108): migrate to log.*` in the most critical paths.

**Acceptance:**

- All new code paths use `log.info / log.warn / log.error`
- JSON output to stdout is parseable by Promtail
- Sensitive fields (`pin`, `password`, `authorization`, `cookie`) are redacted at the logger level
- A test request through the system has a single `request_id` traceable across log lines

### [x] T-109: Prometheus `/metrics` endpoint

Create `src/lib/observability/metrics.ts` registry + custom metrics. Create `src/app/metrics/route.ts` Prometheus text endpoint. Internal-only (404 when reached via Cloudflare tunnel).

Wire middleware-level request counters + duration histograms. Wire custom counters in the MyMRC scrape (per ADR-0009), R2 upload, and (in T-114) M365 mail-send paths.

**Acceptance:**

- `curl http://localhost:3000/metrics` returns valid Prometheus text
- Same URL through the public Cloudflare tunnel returns 404
- Default Node metrics + custom DR3-Vision metrics both present
- Test requests update the request counters; verifying with a follow-up `/metrics` scrape

## Wave C — Signatures + PDF + delivery (parallel after Wave B)

### [x] T-110: Signature capture flow

Implement the signature buttons on `/bonus/months/[id]`. When clicked: confirmation modal with attestation text, server records `*_signed_by_user_id`, `*_signed_at`, `*_signed_ip` (from request), `*_signed_user_agent`.

State transitions per T-106:

- First signature → `partially_signed`
- Second signature → `signed` → triggers PDF generation (T-111) → triggers mail-send (T-114) if both succeed

Janette and Morena each have their own signature button. The UI hides Janette's button after she signs; hides Morena's button after she signs.

**Acceptance:**

- Janette opens a `pending_signatures` month, clicks her button, confirms; row updates with her timestamp + IP + UA
- State transitions to `partially_signed`
- Morena's button is still visible; she signs; state transitions to `signed`
- A user who already signed cannot re-sign (button is disabled)
- An unauthorized user (Rick) cannot reach the page (403)

### [x] T-111: Signature override workflow

Per ADR-0019 §5: Bill OR Morena can sign in Janette's stead; Bill ONLY can sign in Morena's stead. Override is always available (no grace period).

UI: alongside each signature button, a small "Sign on behalf of {name}" link appears for authorized overriders. Clicking opens a modal requiring a reason (free-text, required, audit-logged) before the override is recorded. The `*_override_actor_id` column captures who actually signed.

**Acceptance:**

- Bill sees both "Sign on behalf of Janette" and "Sign on behalf of Morena" links
- Morena sees "Sign on behalf of Janette" but NOT "Sign on behalf of Morena"
- Janette sees neither override link
- An override records the override actor + reason in the database
- The PDF (T-112) reflects the override in the attestation block

### [x] T-112: PDF generation

Generate the bonus PDF via Playwright `page.pdf()` against a server-rendered HTML page at `/internal/bonus-pdf/[month-id]`. The internal route is gated to localhost-only (loopback origin check) so production Playwright can reach it but the public Cloudflare tunnel cannot.

PDF layout per ADR-0019 §10: co-branded header (DR3 logo top-left, SVdP seal top-right), per-employee table body, dual signature block with attestation, footer with document ID + generation timestamp.

The PDF uploads to R2 (`pdfs/bonus/<site>/<YYYY-MM>/<short-uuid>.pdf`) and the storage key persists to `bonus_months.pdf_storage_key`.

For amendments, the PDF title block displays "**AMENDED**" and includes the supersedes-prior-version line.

**Acceptance:**

- A signed test month generates a PDF
- The PDF renders with the correct co-branded layout, brand colors, and Inter typography
- All employee data is accurate; totals match `calculateMonthlyBonus(month)`
- Both signature blocks display with correct names, timestamps, IP, UA, attestation text
- Override attestations clearly indicate the override actor and original signer
- The PDF stored in R2 is downloadable from `/bonus/months/[id]/pdf` for authorized users
- An amended PDF carries the "AMENDED" marker and the supersedes line

### [x] T-113: EOD ntfy enforcement

Cron job runs at 5:00 PM Pacific daily. For each Woodland active day (Mon–Fri excluding `site_holidays`), check if all active employees have `bonus_daily_entries` rows for today. If any are missing, publish to ntfy `dr3-vision-system` with fingerprint `bonus-entry-missing:woodland:<YYYY-MM-DD>`.

Implementation: extend `scripts/mymrc-cron.mjs` to run a 5pm Pacific tick in addition to its hourly schedule, or add a sibling cron script `scripts/bonus-eod-check.mjs`. Latter is cleaner.

**Acceptance:**

- A test run at 5pm Pacific with missing entries produces an ntfy publish to `dr3-vision-system`
- The fingerprint prevents duplicate publishes for the same date
- A weekend or `site_holiday` date is skipped
- Filling in the entries the next morning does NOT retroactively suppress the alert (per ADR-0019 §2)
- The publish includes a useful body: "Bonus entries missing for Woodland — Sept 14, 2026. Open /bonus to enter."

### [x] T-114: M365 Graph mail-send integration

Implement `src/lib/m365-mail.ts` per ADR-0021. Acquire token via `ClientSecretCredential`; call `POST /users/{from-mailbox}/sendMail`. Retry-with-backoff on transient failures (429, 503, 504, network). Publish to ntfy on exhaustive failure.

Audit every send with `actor_label = 'system:m365-mail-send'`. Track in the `payrollDeliverySuccess` Prometheus counter.

Operator runbook documents the mailbox creation, app permission consent, and Application Access Policy restriction (see `docs/operator/m365-mail-send-setup.md`).

**Acceptance:**

- A signed test month auto-delivers PDF to a configured test recipient via Graph
- The Graph response 202 is logged; the message ID (or response context ID) is persisted to `payroll_message_id`
- A simulated 429 retries with backoff; eventual success persists correctly
- An exhausted retry chain publishes ntfy and surfaces a manager-visible "retry delivery" button on the month page
- Without `AUTH_MICROSOFT_ENTRA_ID_*` env vars, the function fails open with a clear error logged

### [x] T-115: Grafana dashboard + alert rules

Commit `grafana/dashboards/dr3-vision.json` with the panel set described in ADR-0022 §5. Commit `grafana/alerts/dr3-vision.yaml` with the alert rules described in §6.

Both files are consumed by the fleet's Grafana provisioning. Reload happens via the fleet's existing watcher; no DR3-Vision-side deploy step needed.

**Acceptance:**

- The `dr3-vision` dashboard appears in Grafana with all panels rendering data
- The Bonus sub-tab shows the bonus_months state distribution + daily entries today panels
- Test alerts (e.g., manually setting `db_ok=false` via a chaos endpoint) fire correctly
- Critical alerts route to ntfy `dr3-vision-system`; warnings stay in-portal

## Wave D — Amendment + history + dashboards (parallel after Wave C)

### [ ] T-125: Signature-request emails (ADR-0019 §5a)

Actively prompt signers by email when their signature is required, so they don't
have to remember to check the portal. Depends on T-110 (signature transitions),
T-106 (`closeMonthsDueForSignature`), and T-114 (M365 mail helper). Builds on the
`sendSystemEmail` generalization of `sendPayrollPdf`.

Implementation:

- New `src/lib/bonus/signature-notifications.ts`:
  - `resolveSlotSigner(slot)` — facility-manager slot → active `manager` with
    `primary_site_id` = Woodland; ops-manager slot → active `manager` with
    `primary_site_id` null. Resolved from the `users` table; no hardcoded addresses.
  - `notifyPendingSigner(month)` — given a month in `pending_signatures` (none signed
    → prompt facility manager) or `partially_signed` (prompt the still-unsigned slot's
    signer), send the signature-request email via M365 and write an `audit_log` row
    (`actor_label = 'system:signature-request'`). Fail-open; links to
    `/bonus/months/[id]`.
- Wire the call at the two transition points:
  - `scripts/bonus-eod-check.mjs` / the month-close path (after `draft →
pending_signatures`, including amendment `amended → pending_signatures`).
  - `src/app/api/bonus/months/[id]/sign/route.ts` (after `pending_signatures →
partially_signed`).
- `src/lib/bonus/signature-notifications.test.ts` — recipient resolution per slot;
  pending_signatures → facility manager; partially_signed → the unsigned slot's
  signer (incl. the override-out-of-order case); fail-open when mail unconfigured;
  audit row written. Mail mocked.

**Acceptance:**

- When a month auto-closes to `pending_signatures`, Janette receives a "ready for
  your signature" email linking to the month page.
- After Janette signs (`partially_signed`), Morena receives a "your signature is
  needed" email; after Morena signs, no further prompt (state `signed`).
- An amendment that returns a month to `pending_signatures` re-prompts Janette.
- Recipients resolve from the `users` table (a rename/role change is reflected).
- Mail unconfigured → signing still works, prompt is skipped + logged (fail-open).
- Every send writes an audit row with `actor_label = 'system:signature-request'`.

### [ ] T-116: Amendment workflow (admin-only)

Bill-only "Unlock month" action on `/bonus/months/[id]` for `signed` and `paid` months. Confirmation modal requires a reason (free-text, required). On unlock:

- State: `signed` (or `paid`) → `amended` → `pending_signatures`
- Both signature columns cleared (preserved in audit log)
- Daily entries become editable again
- `amended_from_month_id` records the prior version
- `amended_by_user_id` and `amended_at` record the unlock

Per ADR-0019 §6, the next PDF is marked "AMENDED" and includes a supersedes-prior-version line. The next mail-send auto-fires after both signatures.

**Acceptance:**

- Janette, Morena, and Rick do NOT see the unlock button
- Bill clicks unlock, provides a reason, the month resets to `pending_signatures` with cleared signatures
- Audit log captures the unlock with actor + reason + full prior state
- A subsequent re-sign and PDF carries the "AMENDED" marker
- The original signed PDF in R2 is preserved (not overwritten — new R2 key for the amended version)

### [ ] T-117: Historical browsing

Past-month read-only views at `/bonus/months/[id]` for any `signed`, `paid`, or `amended` month. Daily grid is locked (read-only), signatures + PDF download visible, audit log slice for the month accessible.

`/bonus/months` lists past months with filter (current month, this year, all-time) and state badges.

**Acceptance:**

- Janette can browse to last month's signed report, see the daily grid (read-only), download the PDF
- Filter by year shows correct month list
- Amended months are clearly badged "AMENDED" with link to prior version
- All visibility is site-scoped — Rick gets 403 on Woodland months

### [ ] T-118: Per-employee + annual aggregate views

`/bonus/employee/[id]` shows one employee's cross-month history: monthly totals, year-to-date, last 12 months chart. Drill-down to monthly daily grid (read-only).

`/bonus/annual` shows per-employee year-to-date totals. CSV export button (admin/manager only, generates and downloads CSV for SVdP internal accounting use).

**Acceptance:**

- Maria Lopez's employee detail page shows her monthly totals for the last 12 months
- A rename (Maria Lopez → Maria Garcia) displays the current name with a "previously known as" badge per ADR-0019 §9b
- Annual aggregate sums correctly across months
- CSV export contains the right columns and downloads cleanly

## Wave E — Polish, residuals, and verification

### [ ] T-119: Microsoft Graph profile photo on Vision Dashboard

Per ADR-0020, fetch the user's profile photo via `GET /me/photo/$value` on first Vision Dashboard load per session. Cache in session for 24h. Fall back to initials circle if Graph fails or the user has no photo.

Uses the existing `User.Read` permission — no new scope needed.

**Acceptance:**

- A user with a Microsoft profile photo sees it on the Vision Dashboard avatar
- A user without a photo sees the initials fallback
- A Graph API outage falls back to initials silently (no error UI)
- The photo is cached for 24h; subsequent dashboard loads skip the Graph call

### [ ] T-120: Health pill expansion + subsystem detail

The Vision Dashboard footer "All systems operational" pill expands on click to show per-subsystem status: db, R2, MyMRC last-tick, ntfy publisher, Graph API (M365 mail-send), GlitchTip ingest.

Per ADR-0020. Each subsystem reports green/amber/red with a one-line detail (e.g., "MyMRC: last successful scrape 47 min ago").

**Acceptance:**

- Click the pill, panel expands with subsystem detail
- A degraded subsystem (forced via test) shows amber with the right detail line
- Polling refresh updates the panel without page reload (30s tick)

### [ ] T-121: Documentation updates

Update `README.md` to add Bonus Management and Vision Dashboard to the "What it does" section. Update `PROJECT-CHARTER.md` with the Sprint 2 section. Update `docs/adr/README.md` with new ADRs 0019–0022.

Add the four new ADRs to the index. Cross-link from existing related ADRs.

**Acceptance:**

- `README.md` lists Bonus Management among active capabilities
- `PROJECT-CHARTER.md` has a §12 "Sprint 2" section summarizing scope
- ADR index includes 0019, 0020, 0021, 0022 with status

### [ ] T-122: Operator residuals — M365 mailbox + permissions

Bill-side runbook execution per `docs/operator/m365-mail-send-setup.md`:

1. Create the `dr3-vision@svdp.us` shared mailbox in M365 admin center
2. Extend the existing Entra app registration with `Mail.Send` application permission
3. Admin-consent the new permission
4. Configure Application Access Policy restricting the app to `dr3-vision@svdp.us` only
5. Generate or rotate the client secret if needed
6. Drop credentials into `~/.dr3-vision-secrets/m365.env` on CHAD-HQ
7. Recreate the app container with `up -d --force-recreate --no-deps app`
8. Verify end-to-end with a manual `/bonus/months/[test-id]/redeliver` call

**Acceptance:**

- A test PDF send from the production container lands in payroll's inbox (or a test recipient initially)
- Exchange message trace shows the send as intra-tenant
- The audit log records the send correctly

### [ ] T-123: Operator residuals — fleet observability env vars

Bill-side runbook execution per `docs/operator/fleet-observability-setup.md`:

1. Create the `dr3-vision` project in GlitchTip; capture DSN + auth token
2. Confirm Tempo, Loki, Grafana, Prometheus endpoints are configured in fleet
3. Drop `GLITCHTIP_DSN`, `GLITCHTIP_AUTH_TOKEN`, `TEMPO_ENDPOINT`, `LOG_LEVEL`, `OTEL_TRACE_SAMPLE_RATE` into `~/.dr3-vision-secrets/observability.env` on CHAD-HQ
4. Configure the fleet's Prometheus scraper to pick up `dr3-vision:3000/metrics`
5. Recreate the app container
6. Verify: forced error appears in GlitchTip; `/healthz` request appears in Tempo; `/metrics` returns valid Prometheus text from inside the fleet network; the DR3-Vision dashboard renders in Grafana

**Acceptance:**

- A test error in the container shows up in GlitchTip within 30 seconds
- A test request shows up as a trace in Tempo
- Loki has structured JSON logs flowing in
- Grafana dashboard renders with live data
- Critical alert (e.g., db_ok false) routes to ntfy correctly

### [ ] T-124: Multi-agent dispatch summary + go-live checklist

Final verification by Bill before announcing to Janette and Morena:

- [ ] All Wave A–D tickets `[x]`
- [ ] `npx tsc --noEmit` clean
- [ ] `npx next lint --max-warnings 0` clean
- [ ] `npm test` and `npx playwright test` both green
- [ ] Production deploy to `dr3-vision.svdp.us` healthy
- [ ] Manual smoke test: full bonus month lifecycle (entry → signature → PDF → email) in production
- [ ] Janette can log in via Entra SSO, see the Vision Dashboard, click Bonus Management, view today's entries
- [ ] Morena can log in, sign a test month, see the PDF in payroll's inbox
- [ ] Bill receives an EOD ntfy if entries are missing
- [ ] Bill can amend a signed month and see the AMENDED PDF arrive correctly
- [ ] All fleet observability subsystems green in Grafana
- [ ] Announcement email drafted and sent to Janette + Morena + Kelsey

When this checklist is `[x]`, Sprint 2 is shipped.

---

## Multi-agent dispatch summary

For Claude Code orchestration:

- **Wave A** (4 tickets, fully parallel): T-100, T-101, T-102, T-103
- **Wave B** (6 tickets, fully parallel after Wave A): T-104, T-105, T-106, T-107, T-108, T-109
- **Wave C** (6 tickets, fully parallel after Wave B): T-110, T-111, T-112, T-113, T-114, T-115
- **Wave D** (4 tickets, fully parallel after Wave C): T-125, T-116, T-117, T-118 (T-125 depends on T-110/T-114 from Wave C)
- **Wave E** (6 tickets, mostly parallel; T-122 and T-123 are operator-side and gate the production go-live but not the code merges): T-119, T-120, T-121, T-122, T-123, T-124

Critical path through code work: T-100 → T-106 → T-110 → T-112 → T-114 → T-116. About 6 hops. With parallel agents, end-to-end wall-clock time is dominated by the most complex single ticket in each wave plus dispatch overhead.

## Out of scope (deliberate)

- **Eugene bonus management.** Schema is site-scoped so it's a future drop-in. Eugene has no equivalent bonus today.
- **Real-time multi-user collaborative editing.** Janette + Morena are not simultaneously editing the same row. Optimistic locking via `updated_at` is sufficient.
- **Mobile-first bonus entry UI.** Janette uses the manager dashboard on a desktop or large iPad in landscape. Responsive treatment for narrow viewports is a polish item, not Sprint 2.
- **Two-factor confirmation on signature.** The Entra session is already MFA-enforced at the tenant level; signature attestation rides on the authenticated session.
- **MRC API integration.** Still pending Sam's team. Will revisit when they're ready.
- **Photo annotation canvas re-tackle.** Still V2.1 backlog.
- **ES + UR native-speaker translation review.** Still V2.1 backlog. The Bonus Management UI is admin-only English per ADR-0017 precedent.

## Risks and mitigations

| Risk                                     | Mitigation                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M365 mailbox creation delayed by SVdP IT | T-114 ships behind `AUTH_MICROSOFT_ENTRA_ID_*` env vars; fails open without them. Test recipient stand-in for QA.                              |
| Logo SVG asset not provided by Bill      | Vision Dashboard uses typographic "DR3" watermark as documented fallback. Real logo drops in as a single asset replacement.                    |
| Bonus formula changes during sprint      | Parameters live in `processor_bonus_rules` table. Change is one seed update, no code change.                                                   |
| Grafana fleet provisioning misconfigured | Dashboards still render once corrected; nothing in DR3-Vision depends on Grafana being live. Operator runbook calls out the verification step. |
| OpenTelemetry SDK + Next.js conflict     | Tested in dev before merge; SDK has known compatibility patterns documented; ticket T-102 acceptance verifies.                                 |
