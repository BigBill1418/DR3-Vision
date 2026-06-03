# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### 2026-06-03 — INCIDENT: public site down ~15 days (DNS proxy flipped off) — RESOLVED

`https://dr3-vision.svdp.us` was unreachable to the public (connection
refused for IPv6-preferring browsers; bare 403 at the Cloudflare edge).
**The app was never down** — `dr3-vision-app`, `dr3-vision-postgres`, and
`dr3-vision-cloudflared` were Up and healthy on CHAD-HQ the entire time,
and the tunnel (`3999bb3b-…`) stayed connected to Cloudflare `sjc01`.

**Root cause (DNS, not service).** The `dr3-vision.svdp.us` **CNAME →
`3999bb3b-….cfargotunnel.com`** had its **Cloudflare proxy turned OFF**
(orange→grey / `proxied:false`). A `cfargotunnel.com` CNAME only routes
when *proxied*; DNS-only it returns a non-routable synthetic address
(observed: ULA `fd10:aec2:5dae::`, no public A) and the edge has no route
for the SNI → 403. Verified via Cloudflare audit log: the flip happened
**2026-05-19T18:05:07Z** inside a **batch DNS edit in the shared `svdp.us`
zone by `james.goss@svdp.us`** (Cloudflare dashboard, IP 216.115.11.18) —
unrelated, accidental collateral. Not an intentional takedown.

**Fix.** `PATCH` the record back to `proxied:true` via the BarnardHQ
zone-scoped CF DNS token. Public edge confirmed `HTTP 200` + `<title>DR3-Vision</title>`
from both anycast IPs (104.21.12.136 / 172.67.152.137) immediately after.

**Follow-up — change-alerting DEPLOYED (2026-06-03).** DR3-Vision is an SVdP
app on SVdP's own domain (`svdp.us`, hosted in BarnardHQ's Cloudflare account);
the `svdp.us` zone is co-administered, and the 2026-05-19 break was an honest
accident — a tunnel CNAME grey-clouded during a legitimate batch DNS edit by
SVdP's own IT (`james.goss@svdp.us`), not a trust/boundary issue. A
`*.cfargotunnel.com` CNAME silently stops routing when unproxied, so the failure
is easy to make and invisible until someone notices the site is down. A drift
guard now catches it regardless of who/why: `ops-monitors/dr3-vision-dns-guard.sh`
on HSH-HQ (5-min cron) compares the live Cloudflare API state of all
`dr3-vision*` records to a known-good baseline (proxied flag, content, type,
adds/deletes) plus a `1.1.1.1` anycast corroboration probe, and pages **ntfy
`dr3-vision-dns`** — `urgent` if the tunnel CNAME is unproxied/unresolvable
(site-down), `high` for other drift, 6 h cooldown, recovery note on return to
baseline. Optional `AUTO_HEAL=1` re-proxies automatically. The stale
`dr3-vision-publisher` ntfy token (invalid post-migration) was re-minted in the
same pass. Best non-automated prevention: a heads-up to SVdP IT that the
`*.svdp.us` tunnel CNAMEs must stay proxied (orange cloud). No app code change —
DNS/control-plane + monitoring only.

### 2026-05-07 — Sprint-1 substantial-complete checkpoint + V2.1 backlog refresh

Doc-only update at the end of the Phase-2 dispatch session. Eight PRs
landed today (#1 healthz, #2 password_hash drop, #3 ntfy wiring, #4
Dockerfile scripts/ hotfix, #5 audit viewer, #6 MyMRC scrape, #7
Sprint-1 carryovers, #8 reconciliation upload). All on `main` at
`e7f16c1`; deployer in flight to roll the cumulative state out.

Sprint-1 status: T-001 through T-017 + T-019 ticked (T-018
observability is the lone outstanding Sprint-1 ticket — promoted to
the V2.1 backlog with explicit "out of scope until Phase-2 themes are
picked" framing). T-016 acceptance ("Upload Woodland's last monthly
CSV → 95%+ rows reconcile cleanly") is a live-data verification owed
once Bill has a real CSV in hand.

V2.1 backlog refresh:
- **Bulk data upload** added per Bill's 2026-05-07 ask. Current paths
  (seed CSV, `/admin/users`, operator capture, MyMRC scrape, monthly
  reconciliation) do NOT cover historical-load backfills or bulk
  source onboarding. Scope axis to be picked with Bill before
  designing.
- Photo annotation canvas re-tackle (descoped from PR #7, blocked on
  offline-queue payload schema migration).
- ES + UR native-speaker translation review across both i18n
  namespaces.

README "Status" section updated from "Pre-Sprint 1" to the substantial-
complete framing with current production URL + the two outstanding
operator residuals (MyMRC creds drop + live reconciliation test).
README "Stack" auth line corrected from "email/password for portal" to
the post-ADR-0016 Microsoft Entra ID SSO reality.

### 2026-05-06 — T-014: admin audit log viewer (/admin/audit)

Closes SPRINT-1-PLAN T-014. Ships an admin-only `/admin/audit` viewer
that lets Bill (and any future admin) trace who did what to which
row. Append-only per CLAUDE.md hard rule #6 + ADR-0007 — no edit /
delete UI exists, the GET-only API route asserts no other HTTP
verbs are exported, and the data layer never calls
`prisma.auditLog.update` or `delete`. Full design in
`docs/adr/0018-audit-log-viewer.md`.

#### Added

- `src/app/admin/audit/page.tsx` — server-rendered viewer mirrors
  the gate / layout conventions of `/admin/users` (page-layer
  `checkAdmin()`, in-page 403 surface, redirect on 401).
- `src/app/admin/audit/AuditFilters.tsx` — `'use client'` filter
  bar. Apply / Reset are `<button onClick>` per CLAUDE.md hard rule
  #10 — no `<form>`. Filters: actor (manager/admin dropdown), table
  (linkable + observed dropdown), date-from / date-to (HTML date
  inputs), action multi-select chips. URL is the persistent state.
- `src/app/admin/audit/AuditList.tsx` — row list with per-row
  collapsible diff (`useState<Set<id>>` toggle).
- `src/app/admin/audit/AuditDiff.tsx` + `diff-util.ts` — in-house
  3-column key/before/after grid with added/removed/changed/
  unchanged colorization. Inline values <60 chars; pretty-printed
  `<pre>` otherwise. Zero external diff deps (no `react-json-view`).
- `src/app/admin/audit/AuditPagination.tsx` — prev/next buttons
  (URLs precomputed server-side so the client component stays thin).
- `src/app/admin/audit/load/[id]/page.tsx` — resolver that looks up
  a load's site and redirects to `/dashboard/[site]/load/[id]`. The
  audit log is site-agnostic; this resolver bridges the gap without
  hard-coding the lookup at every link site. Hard-deleted rows
  bounce back to the audit list rather than 404.
- `src/lib/admin-audit.ts` — data layer. `listAuditEntries(opts)`
  with Prisma `findMany` + `count`, plus a single bulk-IN query per
  linkable table to resolve "does this row still exist?". Linkable
  tables: `users`, `inbound_loads` (the only `table_name` values
  `writeAudit()` currently emits across the codebase). Adding a
  target is one constant + one branch.
- `src/lib/admin-audit-url.ts` — pure parser / builder / ISO-date
  bounds / default-range helpers. Safe for client + server. Default
  date range when neither bound supplied: last 7 days (UTC).
  Defaults are NOT injected into the URL — the server applies them
  silently and the filter UI shows them as the active draft.
- `src/app/api/admin/audit/route.ts` — GET-only JSON endpoint.
  Admin-gated. Returns `{ rows, total, page, per_page, total_pages }`
  for the client and the future CSV-export use case.
- `docs/adr/0018-audit-log-viewer.md` — design + alternatives +
  consequences.
- "Audit log" nav link in the user-list page header.
- 53 new tests:
  - `src/lib/admin-audit-url.test.ts` (18) — parser, builder,
    round-trip, ISO-date bounds, default range.
  - `src/app/admin/audit/audit-diff.test.ts` (13) — diff classifier
    + `deepEqual` (insert / delete / change / nested / arrays).
  - `src/app/api/admin/audit/audit.test.ts` (22) — role gate,
    list shape, ordering, row-existence resolver, filter
    composition, pagination, append-only contract assertion
    (POST/PATCH/PUT/DELETE not exported).

  Total fleet test count: 51 -> 104.

#### Changed

- `src/app/admin/messages.ts` gains an `audit:` block with all
  user-visible strings. No literals leak into the audit components.
  Per ADR-0015 + ADR-0017, the admin surface stays English-only
  for v1; strings stay concentrated here for the eventual mechanical
  i18n pass.
- `src/app/admin/users/page.tsx` — small "Audit log" link added in
  the header (`data-testid="admin-audit-link"`). Existing add-user
  CTA layout preserved.

### 2026-05-06 — Sprint-1 carryover polish (compliance #2+#4, STATUS_LABELS, photo annotation, manager i18n)

Bundled cluster of post-Sprint-1 carryover items. Item 3 (photo
annotation canvas) is descoped to a follow-up PR — see "Descoped"
section below for rationale.

#### Compliance metrics #2 + #4 — wired off `pending`

Both metrics previously rendered as `pending` placeholders. They now
compute against live tables with the same `green/yellow/red`
threshold pattern the other five metrics use:

- **#2 Processed-units submission (≥95% in 1 business day)** — reads
  `processing_sessions` for the dashboard period. Numerator =
  sessions whose `submitted_to_mymrc_at` lands within
  `mymrc_processed_submission_business_days` of `session_date`. The
  table is empty until V2.1's Processor Form workflow ships, so the
  metric grades green-with-empty-corpus today; once V2.1 starts
  writing sessions the grade becomes real with no code change.
- **#4 Recycling rate (CA ≥75%, OR ≥70%)** — reads
  `mymrc_reconciliation_items.external_weight_lbs` joined to the
  parent reconciliation's period window. Surfaces
  `resolved_weight / total_weight` as the MVP proxy for "weight
  diverted from landfill", per `docs/COMPLIANCE.md` §4 MVP note
  ("display the most recent monthly value pulled from MyMRC
  reconciliation"). Caption documents the proxy explicitly so a
  manager understands the value is reconciliation-derived, not the
  canonical landfill-diversion ratio. Becomes a drop-in for the
  canonical numerator/denominator once V2.1's Processor Form
  workflow ships processed-weight tracking.

Both metrics keep their click-through deep-links — same
`?range=custom&from=…&to=…` URL vocabulary as the rest of the
dashboard so a manager bouncing between compliance and the load
list keeps a consistent window.

New tests at `src/lib/compliance.test.ts` cover both metrics:
empty-corpus → green, threshold-boundary → green, within-5pp →
yellow, below-threshold-5pp → red, period scoping, click-through
href, and per-site target honoring (CA 75% vs OR 70%).
12 new tests, all green.

#### STATUS_LABELS hoisted to a single source

Three files inlined parallel `Record<LoadStatus, string>` maps —
`STATUS_LABELS` in `loads-filters.tsx`, `STATUS_DISPLAY` in
`load-row.tsx`, `STAGE_LABELS` in `dock-tile.tsx`. They had drifted
out of sync (the dock variant uses workflow stage names like "Door
open" / "Counting" while the filter + row variants use record-state
names like "Unloading" / "In progress"). Hoisted to:

- **NEW: `src/lib/loads/labels.ts`** — `loadStatusLabel(status, dict)`
  + `loadStageLabel(status, dict)` + `ALL_LOAD_STATUSES` constant. Both
  helpers translate through the manager dictionary, so labels are
  EN/ES/UR localized at the call site (CLAUDE.md hard rule #4).
- **`loads-filters.tsx` / `load-row.tsx` / `dock-tile.tsx`** — now
  consume the shared helper. All three are `'use client'` and reach
  for `useI18n()` for the dictionary.
- **NEW: `src/app/dashboard/[site]/load/[id]/stage-label-server.ts`**
  — server-side helper used by the load-detail page so the page can
  resolve the stage label without crossing the client/server boundary.

`rg "STATUS_LABELS|STATUS_DISPLAY|STAGE_LABELS" src/` now matches
this changelog entry and one comment in `labels.ts` only — no
duplicate maps remain.

#### Manager portal i18n — EN/ES/UR live across the dashboard

Per CLAUDE.md hard rule #4 every user-facing surface must support
EN/ES/UR on day 1. The operator surface shipped with T-008; the
manager portal was carryover. This change closes that gap for every
page under `/dashboard/**` (the `/admin` surface is explicitly out of
scope per ADR-0017 — admin-only, English-only for v1).

- **NEW: `src/i18n/locales/{en,es,ur}/manager.json`** — separate
  namespace from `operator.json` so the dashboard surface can iterate
  without churning the iPad strings (and vice-versa).
- **`src/i18n/dictionary.ts`** — adds `getManagerDictionary(locale)`
  alongside the existing `getDictionary()`. The same `translate()`
  helper serves both shapes; `resolvePath()` widened to `unknown`
  since the algorithm is purely structural.
- **`src/i18n/provider.tsx`** — `I18nProvider` now accepts
  `Dictionary | ManagerDictionary` so the same client component
  serves both route groups. The discriminator is the route group
  (operator/manager) at the layout level, not the type.
- **NEW: `src/app/dashboard/layout.tsx`** — mounts I18nProvider with
  the manager dictionary for every page under `/dashboard/**`.
- **`src/app/dashboard/page.tsx` / `[site]/page.tsx` / loads /
  compliance** — every English literal threaded through `t(...)`. The
  metric-tile is now `'use client'` and reads its bucket labels +
  threshold formatters from the dictionary.

Spanish + Urdu strings are auto-translated (Mexican Spanish, Nastaʿlīq
Urdu) and queued for native-speaker review via the same SVdP staff
channel as the operator-namespace translations. The `_meta` block in
each JSON file documents the dialect + vocabulary choices and flags
the pending-review status.

#### Descoped — Photo annotation canvas (T-007 enhancement)

Item 3 from the task brief. Descoped from this PR for the following
reasons:

1. The acceptance contract is large: in-browser canvas with four
   tools (circle, arrow, freehand, text), separate R2 upload for the
   annotated version, `annotation_storage_key` persistence, re-edit
   from the saved annotation on reload, mobile-first 44px touch
   targets, and integration with the existing offline queue (which
   today carries one blob per photo, not two).
2. The offline-queue payload schema (`src/lib/offline-queue.ts`) would
   need a backwards-compatible migration to carry the annotated PNG
   alongside the raw photo so they replay together — that's a
   schema-touching change deserving its own ticket and ADR.
3. Bundling it into this polish PR would push the diff past the
   review threshold for the other three items and risk regressions in
   the photo-capture path that the operator-iPad flow depends on.

Unblocking notes for the follow-up PR:

- Schema is already in place: `LoadPhoto.annotation_storage_key`
  (nullable) lives at `prisma/schema.prisma:386`, written nowhere.
- Photo-flow entry point is `src/app/operator/[site]/load/[id]/
  photo-input.tsx` — current contract is capture → R2 PUT → confirm.
  Annotation slots in between R2 PUT (raw) and confirm; the `confirm`
  endpoint at `src/app/api/photos/confirm/route.ts` already accepts
  the LoadPhoto row write — extend it (or add a sibling `/annotate`
  route) with an `annotation_storage_key` field.
- Tests pattern lives at `src/app/healthz/route.test.ts` and
  `src/app/api/admin/users/users.test.ts` — vitest with
  `vi.mock('@/lib/prisma', …)`. Recommend pure HTML5 `<canvas>` over
  `react-konva` to keep the dep surface narrow (~0 KB vs +25 KB gz).

#### Verification

- `npm test` → 6 files / 63 tests pass (was 5/51; +12 new compliance tests).
- `npx tsc --noEmit` → 0 errors.
- `npx next lint --max-warnings 0` → 0 warnings.

### 2026-05-06 — T-016: CSV reconciliation upload (manager portal)

Sprint-1 ticket T-016. Manager-portal page at
`/dashboard/{site}/reconciliation` that ingests the monthly MyMRC CSV,
matches every haul against DR3-Vision's `inbound_loads` by
`external_mymrc_haul_id`, and surfaces five categorized buckets:
`match_clean`, `weight_mismatch` (default ±2% tolerance, configurable
per upload), `count_mismatch`, `missing_in_dr3`, `missing_in_mymrc`.

Per-row resolution actions (`DR3-Vision is correct` / `MyMRC is
correct` / `Flag for follow-up`) write a `mymrc_reconciliation_items`
update + an audit_log entry in one Prisma transaction
(CLAUDE.md hard rule #6 — append-only audit). CLAUDE.md hard rule #2
(Eugene/Woodland strictly separated): manager scoped to one site
cannot reach the other's data; admin sees both. CLAUDE.md hard rule
#10 (no `<form>`): all submissions are `onClick` + `fetch`.

Idempotency: `(site_id, content_sha256)` unique index — re-uploading
the same byte-identical file returns the existing session ID with
`created: false`, never produces duplicate items or audit rows.
Upload metadata persisted: `filename`, `content_sha256`,
`weight_tolerance_pct`, by-category counts.

#### Added

- `prisma/migrations/20260506232606_t016_reconciliation_upload_metadata/migration.sql` — extends `mymrc_reconciliations` with upload metadata + by-category counts; extends `mymrc_reconciliation_items` with DR3-side snapshot + `resolution` enum; adds the idempotency unique index.
- `src/lib/reconciliation.ts` — pure parser + categorizer + persistence helpers + cross-site-safe resolution writer.
- `src/app/api/reconciliation/[site]/upload/route.ts` — multipart upload endpoint, `requireManagerForSite` gate, 25 MiB ceiling, configurable tolerance, dedupe via SHA-256.
- `src/app/api/reconciliation/[site]/items/[itemId]/resolve/route.ts` — per-item resolution writer, double-checked cross-site rejection.
- `src/app/dashboard/[site]/reconciliation/page.tsx` + `UploadClient.tsx` + `[id]/page.tsx` + `[id]/ReconciliationTable.tsx` — manager-portal landing, upload widget, per-session table grouped by category with sortable headers + per-row resolution buttons.
- `src/lib/reconciliation.test.ts` (28 tests) + `src/app/api/reconciliation/[site]/routes.test.ts` (10 tests) — parser, categorizer, persistence idempotency, cross-site rejection, audit-row write contract.
- Nav link from `/dashboard/{site}` → reconciliation.

#### Schema notes

`ReconciliationStatus` enum gains `match_clean`, `missing_in_dr3`,
`missing_in_mymrc`. The legacy `unmatched_in_dr3` / `unmatched_in_mymrc`
/ `resolved` values are retained so the v0.1 compliance read keeps
working — the T-016 engine never writes them. New
`ReconciliationResolution` enum: `unresolved` (default at upload) /
`dr3_correct` / `mymrc_correct` / `flag_followup`.

### 2026-05-06 — T-015: MyMRC hourly schedule scrape (data ingestion)

Closes T-015 in `docs/SPRINT-1-PLAN.md`. Implements the MVP read-path
of the MyMRC integration per ADR-0009: a long-running cron host
container drives one boot scrape + one scrape at the top of every UTC
hour, with two separate Playwright contexts (one per site, separate
credentials) pulling the next 7 days of scheduled hauls and idempotently
upserting them into `expected_loads`. Stale rows in the same window
are flagged `cancelled_at = now` (NOT deleted — preserves audit trail).
Failures publish to `dr3-vision-system` ntfy with a per-site fingerprint
+ 30-min cooldown. No per-haul alerts (CLAUDE.md hard rule #5 +
ADR-0037 — system-level only).

#### Added

- `src/lib/mymrc/types.ts` — shared types (`SiteCode`, `SiteCredentials`,
  `ScrapedHaul`, `ScrapeResult`, `SiteScrapeOutcome`).
- `src/lib/mymrc/selectors.ts` — Playwright selectors with a dated
  `SELECTOR_VERSION` constant. Per ADR-0009, the most fragile file in
  the codebase — when MRC redesigns the portal, this is the first thing
  that breaks.
- `src/lib/mymrc/parser.ts` — pure HTML → `ScrapedHaul[]` transformation.
  Header-driven column lookup tolerates ordering + label drift.
  Strict date validation (Feb 30 rejected, not silently rolled into
  March), comma-stripped numeric parsing, HTML entity decoding,
  graceful drop of rows missing required fields.
- `src/lib/mymrc/credentials.ts` — env-driven per-site credential
  reader. Accepts both site-name form (`MYMRC_EUGENE_*` /
  `MYMRC_WOODLAND_*`) and the legacy jurisdiction form (`MYMRC_OR_*`
  / `MYMRC_CA_*`) from `docs/MYMRC-INTEGRATION.md`. Site-name wins on
  conflict; partial pairs treated as unconfigured.
- `src/lib/mymrc/scrape.ts` — Playwright orchestration. Per ADR-0009
  uses an isolated `BrowserContext` per site with persisted storage
  state (`~/.dr3-vision/mymrc-{site}/auth.json`); detects login
  redirect and re-authenticates on demand. Throws on failure so the
  cron wrapper can publish to ntfy.
- `src/lib/mymrc/upsert.ts` — idempotent upsert into `expected_loads`
  matched by `external_mymrc_haul_id` (globally unique per ADR-0009).
  Pre-resolves source / transporter FKs in two queries (no N+1).
  Tracks unmatched-source / unmatched-transporter counts in the summary
  so the operator runbook can surface seed gaps. Stale-haul cleanup
  scoped to the same 7-day window the scrape covers; cancellation sets
  `cancelled_at = now` and writes a `soft_delete` audit row. Inline
  audit writer takes the caller's `PrismaClient` (the cron worker
  uses its own client, separate from the in-app singleton).
- `src/lib/mymrc/index.ts` — barrel export so consumers can pull from
  `@/lib/mymrc`.
- `src/lib/mymrc/parser.test.ts` (14 tests), `credentials.test.ts`
  (11 tests), `upsert.test.ts` (8 tests) — 33 tests in total covering
  the parser fixtures, the no-credentials fail-soft contract, and the
  upsert paths (insert / no-change / material-update / re-cancel /
  unmatched-FK / stale-cancel) against a mocked Prisma client. All
  fixtures are inline; tests never touch the live MyMRC portal per the
  runbook prohibition.
- `scripts/mymrc-scrape.mjs` — one-shot scrape wrapper (boot + manual
  invocation). Handles the per-site loop, ntfy publish on failure with
  fingerprint `mymrc-scrape-fail:<site>`, exit-code policy
  (0 = at-least-one-site-OK or all-no-creds; 1 = all-configured-sites-failed
  to avoid restart-policy thrashing).
- `scripts/mymrc-cron.mjs` — long-running cron host. Re-spawns
  `mymrc-scrape.mjs` once on boot (after a 5s settle) and once at the
  top of every UTC hour. Anchored to the wall clock (not interval-based)
  so two scrapes can never collide. Graceful shutdown on
  SIGTERM/SIGINT with a 30s grace window for an in-flight scrape.
- `tsconfig.mymrc.json` — minimal tsc project that compiles JUST
  `src/lib/mymrc/*.ts` to CommonJS at `dist/mymrc/`. The Next.js
  standalone bundle does not include arbitrary `src/lib/` modules
  (only what Next's tracer reaches from app routes); the cron
  container needs the compiled output to import via `createRequire`.
- `docs/operator/mymrc-setup.md` — Bill-side runbook: credential drop
  on CHAD-HQ (mode 600), `up -d --force-recreate` (NOT `restart` —
  same lesson as the Entra and ntfy setups), verification, rotation
  (with auth-state wipe), troubleshooting (selector breakage, CAPTCHA,
  account lockout, OOM).

#### Changed

- `Dockerfile` builder stage — adds
  `RUN npx tsc --project tsconfig.mymrc.json` after `npm run build`
  so `dist/mymrc/` lands in the builder for the runner copy.
- `Dockerfile` runner stage — copies `/app/dist`, `node_modules/playwright`,
  and `node_modules/playwright-core` from the builder so the cron
  container can `require('./dist/mymrc')` and `import { chromium }
  from 'playwright'` at runtime. Browser binaries already present
  via the `mcr.microsoft.com/playwright:v1.48.0-jammy` base image.
  Scripts/ COPY comment block updated to mention the new wrappers.
- `docker-compose.yml` — new `mymrc-scrape` service (`image:
  dr3-vision-app:local`, `command: ['node', 'scripts/mymrc-cron.mjs']`,
  `restart: unless-stopped`). Depends on postgres-healthy +
  migrate-completed-successfully. Optional env_files for
  `mymrc.env` (credentials) and `ntfy.env` (alert publisher) so the
  service boots fail-soft without either. New
  `mymrc-auth-state` named volume mounted at
  `/var/lib/dr3-vision/mymrc-auth` so Playwright storage state
  survives container restarts.
- `package.json` — new scripts `build:mymrc` (compiles the cron
  worker) and `mymrc:scrape` (one-shot local invocation).
- `.env.example` — `MYMRC_*` block expanded with the site-name form
  as the documented preferred shape, the jurisdiction-form aliases
  commented out, and the `MYMRC_HEADLESS` flag exposed.
- `.gitignore` — adds `/dist` (regenerated by `npm run build:mymrc`,
  shipped into the runtime image at build time).
- `docs/SPRINT-1-PLAN.md` — T-015 ticked.

#### Operator residual

Bill needs to drop `~/.dr3-vision-secrets/mymrc.env` on CHAD-HQ with
both site credential pairs and recreate the cron container. Full
instructions in `docs/operator/mymrc-setup.md`. Until that lands the
worker logs `creds not configured, skipping` per tick and exits 0
(no ntfy alert — that's an operator state, not a system error). Once
credentials are in place, the next hourly tick begins populating
`expected_loads`.

#### Out of scope (deliberate)

- Source-name backfill UI when the `unmatchedSources=N` counter is
  non-zero. The seed CSV path remains the canonical add-source surface
  until the V2.1 admin Sources page lands. The summary counter is
  surfaced in the cron logs so operators can see the gap.
- The MyMRC write-path (V2.1 backlog per ADR-0009).
- Selector versioning header in `docs/MYMRC-INTEGRATION.md` (queued
  for Sprint 2 once a redesign actually happens).

### 2026-05-06 — Hotfix: COPY scripts/ in runner stage of Dockerfile

PR #3 (`feat(ntfy): wire system-level event publishing`) switched the
`migrate` service `command` in `docker-compose.yml` from the bare
`prisma migrate deploy` to a wrapper at `scripts/migrate-with-ntfy.mjs`.
The wrapper exists in the repo, but the Dockerfile runner stage only
copied `.next/standalone`, `.next/static`, `public/`, `prisma/`, and
select `node_modules/` subtrees from the builder. `scripts/` was never
copied. On deploy of `12afd6e` to CHAD-HQ (2026-05-06 22:29 UTC) the
migrate container hit `MODULE_NOT_FOUND` and exited 1; `dr3-vision-app`
sat in `Created` state because `depends_on.migrate.condition:
service_completed_successfully` never resolved; site was DOWN. Manual
recovery: hand-revert the compose `command` line on CHAD-HQ to the bare
`prisma migrate deploy`, remove the failed migrate container, recreate
the stack. The hand-edit will be overwritten by the next deployer pull
— this hotfix restores `scripts/` to the runtime image so the upstream
compose command resolves.

#### Fixed

- `Dockerfile` runner stage — added
  `COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts`
  alongside the existing per-package `node_modules/` copies. Comment
  block explains the standalone-bundle gotcha and references this
  incident.

#### Lesson

This is the second instance of the Next.js standalone-bundle gotcha
(first was `papaparse` for `prisma/seed.mjs`). When code paths run
**outside** the Next.js server runtime — init containers, cron
wrappers, maintenance scripts — they need an explicit `COPY` from the
builder stage. Anything new dropped into `scripts/` follows the same
rule.

### 2026-05-06 — Healthz body alignment for deploy-gate

`/healthz` now emits `"status":"ok"` (200) on healthy and
`"status":"degraded"` (503) on db-probe failure, alongside the existing
`ok / version / uptime_s / db_ok` fields. The swarmpilot deployer
(`noc-master/api/services/deployer-worker.js`,
`DEFAULT_HEALTH_MATCH = "status"\s*:\s*"(ok|healthy)"`) is the body-match
gate shared by 18 fleet repos; without a `status` field the gate ran
to its 15-min deadline on every deploy. Live observation: commit
`9a166b7` sat at attempt 90+ with `last_reason: "body did not contain
status:ok|healthy"` despite the container being live and serving
`db_ok:true`. Failure-mode is preserved — `"status":"degraded"`
intentionally does NOT match the regex, so a degraded service
correctly fails the gate and triggers rollback. Fixed app-side rather
than deployer-side because the deployer regex is shared infrastructure;
the rest of the fleet already speaks this contract. Tests added at
`src/app/healthz/route.test.ts` cover both branches plus a direct
regex assertion against the deployer's exact pattern.

### 2026-05-06 — Sprint-2 cleanup: drop User.password_hash

ADR-0016 made Microsoft Entra ID SSO the only sign-in path for managers
and admins; operators continue to use PIN auth (ADR-0004). The
`User.password_hash` column was left in the schema as vestigial. This
cleanup drops it.

#### Migration

- NEW: `prisma/migrations/20260506215753_drop_user_password_hash/migration.sql`
  — `ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash"`. Test
  applied forward against a Postgres 16 instance with a populated row
  (the production-style `pending_first_password_reset` placeholder), then
  re-applied to confirm Prisma's `_prisma_migrations` ledger marks it
  applied and skips the SQL on subsequent `migrate deploy`. The
  `IF EXISTS` guard makes the SQL itself idempotent if an operator ever
  runs it by hand. Production rows currently carry the seed sentinel
  string — no real Argon2id hash is being lost.

#### Schema

- `prisma/schema.prisma` — removed the `password_hash` field from the
  `User` model. Comment now points at the cleanup migration + ADR-0016
  for the why.

#### Code

- `src/lib/admin-users.ts` — removed the `SEED_PLACEHOLDER_HASH`
  constant, dropped `password_hash` from the `AuditableUser`
  `Pick<>`, removed the `password_set` field from `ScrubbedUser`,
  deleted the create-time `passwordHash` calculation + the update-time
  `password_hash` backfill block. The defensive `password_hash` check
  in `serializeForAudit()` stays — it is now a forward-defense: if a
  future refactor re-introduces a password-shaped column, the runtime
  probe trips before the value reaches the append-only audit log
  (CLAUDE.md hard rule #6).
- `src/lib/admin-users.test.ts` — dropped the four scrubber tests that
  exercised `password_hash` shapes; left the negative `serializeForAudit`
  guard test that asserts the runtime probe still rejects a tainted
  object carrying a `password_hash` key.
- `src/app/api/admin/users/users.test.ts` — removed `password_hash` from
  the in-memory `MockUser` interface, the `insertUser()` helper, the
  `prisma.user.create` mock, and the `prisma.user.update` mutable-field
  list. The `expect(json).not.toContain('password_hash')` PII assertions
  in the `create operator` + `reset PIN` cases are retained as
  forward-defenses against type drift.
- `src/lib/auth.ts` — comment block updated; the "vestigial; queued for
  removal" note replaced by a pointer to the cleanup migration.
- `prisma/seed.mjs` — removed the `password_hash: blankToNull(r.password_hash)`
  field from `seedUsers()`'s `data` object.
- `prisma/seed/users.csv` — dropped the `password_hash` column entirely;
  notes updated to describe the Entra SSO + `/admin/users` activation
  flow instead of password-reset bootstrapping.
- `prisma/seed/README.md` — `users.csv` section + integrity-reminder
  bullet updated to reflect ADR-0016 reality (Entra SSO + admin-panel
  activation; no password to seed).

#### Removed

- `scripts/set-password.mjs` — the bootstrap CLI that hashed a
  password into `users.password_hash`. Dead code post-ADR-0016 and
  doubly so post-Sprint-2 (the column it wrote to is gone). Removed
  in this PR rather than left as a runtime trap.

#### Charter

- `PROJECT-CHARTER.md` §6 schema sketch — `password_hash` line
  replaced with a comment pointing at ADR-0016 + the Sprint-2 cleanup.

#### Production rollout

The migrate container runs `prisma migrate deploy` on every deploy.
On the next CHAD-HQ deploy this migration applies, the column is
dropped, and the cluster runs without it. Rollback story: `git revert`
of this PR reintroduces the column at the schema level via a follow-up
migration (Prisma will detect the divergence and prompt for a new
forward migration); rolling back the database column itself requires a
manual `ALTER TABLE "users" ADD COLUMN "password_hash" TEXT` if needed
— but since no row carries a real hash, "rollback" is academic.

### 2026-05-06 — DR3-Vision ntfy wiring (system-level events only)

Closes the Sprint-1 residual where DR3-Vision was scaffolded for ntfy but
never finished wiring. Substrate (server, token, ACL, registry) was healthy
end-of-day 2026-05-06; the app side simply didn't publish anything. This
change adds the publisher helper, three system-level call sites, the
operator runbook for the token + env_file drop, and the unit tests.

Per CLAUDE.md hard rule #5 + docs/COMPLIANCE.md the publishes are limited
to **system-level events**: container start, migration applied, unhandled
error. Operational events (rejections, long unloads, SLA breaches, PIN
lockouts) stay on the in-app dashboard and are explicitly NOT wired.

#### Added

- `src/lib/ntfy.ts` — `publishNtfy()` helper implementing the ADR-0036
  contract (X-Title, Authorization: Bearer, Click, Priority, Tags) and
  the ADR-0037 cooldown enforcement (per-fingerprint, default 5 min,
  caller-overridable). Publisher-side fallback to `ntfy.sh` with
  `[FALLBACK]` prefix on primary failure, using the obscured topics
  registered in `~/noc-master/data/ntfy-fallback-topics.yml`. Three
  convenience wrappers — `publishContainerStart`,
  `publishMigrationApplied`, `publishUnhandledError`.
- `src/instrumentation.ts` — Next.js instrumentation hook that fires the
  boot publish (30-min cooldown so a crashloop doesn't spam) and wires
  `process.on('uncaughtException')` + `unhandledRejection` to publish
  with a 30-min per-fingerprint cooldown.
- `scripts/migrate-with-ntfy.mjs` — wraps `prisma migrate deploy` and
  publishes one event per newly-applied migration (snapshot before,
  snapshot after, diff). Replaces the bare invocation in `docker-compose.yml`'s
  `migrate` service.
- `docs/operator/ntfy-setup.md` — Bill-side runbook: token lookup on
  HSH-HQ, env_file drop on CHAD-HQ (mode 600), `force-recreate` (NOT
  `restart`, same lesson as the Entra setup), verification, rotation,
  troubleshooting.
- `src/lib/ntfy.test.ts` — 14 unit tests covering token-less no-op,
  successful primary publish + headers, fallback path with prefix +
  Authorization stripping, fingerprint cooldown suppression, expiry,
  and the three convenience wrappers.

#### Changed

- `.env.example` — `NTFY_BASE_URL` corrected from `https://ntfy.svdp.us`
  (wrong host, never existed) to canonical `https://ntfy.barnardhq.com`.
  Variables renamed to match the helper: `NTFY_TOPIC_SYSTEM`,
  `NTFY_TOPIC_CONTAINER`, `NTFY_PUBLISHER_TOKEN`. Comment block points at
  the operator runbook for the production token.
- `docker-compose.yml` — `app` and `migrate` services pick up an
  optional `~/.dr3-vision-secrets/ntfy.env` env_file (`required: false`
  so the app boots without ntfy if the operator hasn't dropped it yet).
  `migrate` service `command` switched from bare `prisma migrate deploy`
  to the new wrapper script.

#### Operator residual

Bill needs to drop `~/.dr3-vision-secrets/ntfy.env` on CHAD-HQ and recreate
the app container. Full instructions in `docs/operator/ntfy-setup.md`.
Until that lands the publisher path is a successful no-op; nothing breaks.

### 2026-05-06 — Entra SSO production cutover + runbook fixes

Live SSO ship for `bill.barnard@svdp.us` (admin) on
<https://dr3-vision.svdp.us>. Azure tenant single-tenant app
registration, `DR3-Vision Admins` security group as the assignment-required
gate, env_file values dropped on CHAD-HQ + container recreated. First
admin DB row seeded directly via SQL (chicken-and-egg: `/admin/users`
panel can't help bootstrap when nobody has logged in yet).

#### Fixed in `docs/operator/entra-id-setup.md`

- **Issuer trailing slash.** Runbook prescribed
  `https://login.microsoftonline.com/<tenant-id>/v2.0/`; Microsoft's
  OIDC discovery returns the issuer without a trailing slash. Auth.js
  refused with `"response" body "issuer" does not match
  "expectedIssuer"` and rendered a generic "Server error" page. Stripped
  the slash, added a callout in §2 + a troubleshooting note in §6.
- **Container restart vs. recreate.** Step 5 said `docker compose
  restart`. That stops/starts the existing container, which keeps the
  pre-existing (empty) env baked in from create time — new env_file
  values never load. Switched to `up -d --force-recreate --no-deps app`
  with the explanation. Step 7 (rotation) updated to match.
- **§4 — Group policy made non-optional.** Was "Optional: restrict
  access at the tenant." Now it's the canonical gate: every SSO user
  must be in the `DR3-Vision Admins` Entra security group AND have an
  active DB row. Onboarding rule documented (add to group → activate /
  create DB row). Group is intentionally shared across both roles; app
  signIn callback decides admin vs. manager from the DB `role` column.
- **`sudo -u dr3-vision`** removed from the §5 SSH steps. The actual
  CHAD-HQ secrets dir is owned by `bbarnard065`, not a service account.

#### Custom error routing (replaces Auth.js bare error page)

The default `/api/auth/error` page rendered a generic "Server error /
There is a problem with the server configuration. Check the server logs
for more information." for every failure class — including the harmless
back-button-through-callback case where the PKCE verifier cookie has
already been consumed. Routed it back to the styled `/login` surface
instead so users get a clear, role-appropriate hint.

##### Changed

- `src/lib/auth.config.ts` — added `pages.error: '/login'` so Auth.js
  redirects every callback failure to `/login?error=<code>` instead of
  its own generic page.
- `src/app/login/login-form.tsx` — rewrote the error-param mapping as a
  switch and added a `Callback` case mapped to a new
  `auth_login.error_session_expired` string. Doc comment now lists every
  Auth.js error code we handle and what each one means.
- `src/i18n/locales/{en,es,ur}/operator.json` — new
  `auth_login.error_session_expired` translation in all three locales.
  ES + UR translations queued for native-speaker review (see Sprint-1
  residual list).

### 2026-05-06 — Post-Sprint-1: ADR-0016 Entra SSO + ADR-0017 Admin Settings

#### ADR-0016: Microsoft Entra ID SSO for managers + admins

Closes the post-Sprint-1 directive "entra only - sso only for admins
and managers." Operators are unaffected — PIN auth on the iPad stays.

##### Added

- `src/lib/auth.config.ts` — declares the `MicrosoftEntraID` OIDC
  provider, edge-safe (no Prisma). Auto-reads
  `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER`.
- `src/lib/auth.ts` — `evaluateEntraSignIn()` gate (exported for
  unit testing) and a `signIn` callback that:
  - allows the operator PIN flow unconditionally (already gated by
    its own `authorize` callback);
  - on Entra sign-in, looks up the user by lowercased email, denies
    unknown / inactive / soft-deleted / non-manager-or-admin
    accounts, mirrors the locale cookie, and updates `last_login_at`.
- `src/lib/__tests__/auth.signin-gate.test.ts` — 9 unit tests
  covering: allow manager, allow admin, deny operator, deny inactive,
  deny soft-deleted, deny unknown email, deny pin-only (no email)
  account.
- `src/i18n/locales/{en,es,ur}/operator.json` — new `auth_login`
  keys: `sign_in_with_microsoft`, `redirecting`, `sso_only_hint`,
  `error_access_denied`, `error_not_configured`, `error_generic`.
- `docs/adr/0016-entra-id-sso-managers-admins.md` — full ADR.
- `docs/operator/entra-id-setup.md` — Bill-side runbook for
  registering the Azure App, minting a secret, and rolling values
  onto CHAD-HQ.
- `.env.example` — new `AUTH_MICROSOFT_ENTRA_ID_*` block with the
  redirect-URI hint and runbook pointer.

##### Changed

- `src/app/login/login-form.tsx` — single "Sign in with Microsoft"
  CTA. Surfaces `error=AccessDenied` (gate-denied) and
  `error=Configuration` (env vars unset) as localized messages.
  Locale picker preserved. Per CLAUDE.md hard rule #10 the form
  uses `onClick`, not `<form>`.
- `src/middleware.ts` — `PUBLIC_PATHS` no longer lists
  `/forgot-password` or `/reset-password`.

##### Removed

- `src/app/forgot-password/` (page + form)
- `src/app/reset-password/` (page + form)
- `src/app/api/auth/forgot-password/route.ts`
- `src/app/api/auth/reset-password/route.ts`
- `src/lib/password-reset-token.ts` (HMAC-signed reset token util,
  unused after removing the reset endpoints)
- `src/lib/email.ts` (Resend stub, unused after removing the reset
  endpoints — PIN flow doesn't email)
- `RESEND_API_KEY` / `EMAIL_FROM` env vars from `.env.example`
- The email + password Credentials provider in `auth.ts`
- `auth_forgot.*` and the email/password keys under `auth_login.*` in all
  three locale dictionaries.

##### Vestigial — to be cleaned up in Sprint-2

- `users.password_hash` column. No code path reads or writes it
  after this change. A dedicated Sprint-2 migration will drop it.
  Left in place this sprint to keep the ADR-0016 PR free of
  irreversible schema work and rollback-able by `git revert` alone.

#### ADR-0017: Admin Settings panel (`/admin/users`) for user seeding

First in-portal user-management surface. Replaces the bootstrap-CSV
seed for ongoing day-to-day adds, edits, deactivations, and
operator PIN resets.

##### Surface

- `/admin` → redirects to `/admin/users`.
- `/admin/users` — list with URL-driven filters
  (`?site=&role=&status=`). Sort by name. Default hides inactive.
- `/admin/users/new` — create form. Operator gets PIN + confirm-PIN
  fields; manager/admin get an email field (no password). Eugene
  operators get the `processor_role` dropdown.
- `/admin/users/[id]` — edit form, "Reset PIN" modal (operators
  only), Deactivate / Reactivate buttons. Self-deactivate refused.
- "Admin" link in the dashboard header, visible only when
  `session.user.role === 'admin'`.

##### API

- `POST /api/admin/users` — create.
- `GET /api/admin/users` — list (JSON).
- `PATCH /api/admin/users/[id]` — discriminated union by `action`:
  `update | reset_pin | deactivate | reactivate`.
- `DELETE /api/admin/users/[id]` — alias for `{action:'deactivate'}`.
- All endpoints gated to `role='admin'`. Manager + operator both
  return 403; anonymous returns 401. The middleware-level redirect
  is NOT trusted by the API.

##### Data + audit

- `src/lib/admin-users.ts` — server-only CRUD module. Every
  mutation is a `prisma.$transaction` paired with an `AuditLog`
  insert. Operator creation reuses `setPin()` from
  `src/lib/pin-service.ts`, preserving the per-site uniqueness
  loop-verify (ADR-0012 §3) and the "PIN hash never indexed" rule
  (CLAUDE.md hard rule #8).
- `scrubUserForAudit()` strips `pin_hash` and `password_hash` from
  every audit `before` / `after` snapshot, replacing them with
  `pin_set` / `password_set` boolean markers. A defensive runtime
  probe in `serializeForAudit()` throws if either secret-hash key
  ever sneaks back in — append-only audit rows mean a leaked hash
  would persist forever (CLAUDE.md hard rule #6).
- The `AuditAction` enum is unchanged. PIN resets share the
  `update` action; the `before`/`after` JSON differentiates.

##### Files

- NEW: `src/lib/admin-users.ts`
- NEW: `src/app/admin/{page,messages,constants}.ts(x)`
- NEW: `src/app/admin/users/{page,UserListClient}.tsx`
- NEW: `src/app/admin/users/new/{page,UserCreateForm}.tsx`
- NEW: `src/app/admin/users/[id]/{page,UserEditForm}.tsx`
- NEW: `src/app/api/admin/users/route.ts`
- NEW: `src/app/api/admin/users/[id]/route.ts`
- NEW: `vitest.config.ts`
- NEW: `src/lib/admin-users.test.ts`
- NEW: `src/app/api/admin/users/users.test.ts`
- NEW: `docs/adr/0017-admin-settings-panel.md`
- MOD: `src/lib/auth-helpers.ts` — adds `requireAdmin()` +
  `checkAdmin()` mirroring the existing manager-site helpers.
- MOD: `src/app/dashboard/page.tsx` — Admin link visible only to
  admins.
- MOD: `docs/adr/README.md` — index entry for ADR-0017.

##### Verification

- `npx tsc --noEmit` clean
- `npx next lint --max-warnings 0` clean
- `npx vitest run` — 29/29 pass (10 PII-scrubber unit + 19 API
  integration with mocked Prisma + auth, real Argon2id hashing
  for the operator PIN-collision path).
- `npm run build` — admin routes compile, no client bundle drags
  in argon2 native binding (constants extracted).

### 2026-05-06 — T-008: i18n (English / Spanish / Urdu) — Sprint-1 complete

Closing the last open Sprint-1 ticket. CLAUDE.md hard rule #4 — all
user-facing copy supports English, Spanish, and Urdu (RTL) on day 1
— is now satisfied for every operator surface.

#### Added

- `src/i18n/config.ts` — locale registry (`en`/`es`/`ur` mirroring the
  prisma `UserLocale` enum), `dr3_locale` cookie name, RTL detector,
  picker labels written in their target language.
- `src/i18n/dictionary.ts` — synchronous JSON imports of the three
  locale files. Mustache `{{var}}` interpolation,
  `_one`/`_other` plural variant chooser, dot-path resolver. The
  English JSON is the canonical type; Spanish/Urdu inherit it via a
  TS cast that fails the typecheck on key drift.
- `src/i18n/get-locale.ts` — server-side resolver. Precedence: `?lang=`
  > `dr3_locale` cookie > `users.locale` from session > `en` default.
- `src/i18n/provider.tsx` — `<I18nProvider>` + `useT()` /
  `useTPlural()` / `useLocale()` / `useI18n()` hooks. Dictionary
  travels through the RSC payload, no client fetch, no flash of
  untranslated content.
- `src/i18n/actions.ts` — `setLocaleAction()` server action used by
  the locale picker. Writes the cookie + (when a session exists)
  the user's `users.locale` row.
- `src/i18n/locales/{en,es,ur}/operator.json` — single namespace
  `operator` with ~120 keys covering every visible string in the
  operator surface.
- `src/lib/format.ts` — `formatTime` / `formatDate` / `formatRelative`
  now accept an optional `locale` arg. Caches `Intl.DateTimeFormat`
  instances per-locale. `formatRelative` returns translated strings.
- `src/app/login/layout.tsx` (NEW) — provider wiring for `/login`.
- `src/app/login/locale-picker.tsx` (NEW) — three-button picker
  (English / Español / اردو) above the sign-in CTA.
- `src/app/operator/layout.tsx` (NEW) — wires the I18nProvider for
  the entire `/operator` route group.
- `docs/adr/0015-i18n-architecture.md` — full ADR.

#### Changed

- `src/app/layout.tsx` — `<html lang>` + `<html dir>` set from the
  resolved locale. Tailwind's logical-property utilities flip layout
  automatically.
- `src/app/login/login-form.tsx`, `src/app/login/page.tsx` — locale
  picker integrated; form copy + error messages translated.
- All operator-surface pages + components — every user-facing string
  translated and wired through `useT()` hooks.
- `src/lib/auth.ts` — both credential providers call
  `mirrorLocaleCookie(userId)` to persist locale to `users.locale`.

#### RTL handling

- PIN keypad, unload timer (`mm:ss`), and photo-input filename forced
  `dir="ltr"` so numerals stay universally left-to-right.
- Textareas set `lang={locale}` for iPadOS dictation language detection.

#### Verification

- `npm run lint` — clean.
- `npm run typecheck` — clean.
- `npm run build` — clean. Operator-page sizes unchanged; dictionary
  travels through RSC payload, not client bundle.

#### Out of scope (flagged follow-ups)

- **Manager portal i18n** — only operator surfaces ship this sprint.
- **Server-side `<title>` metadata translation.**
- **Spanish + Urdu native review** — files flagged in headers as auto-translated.

### 2026-05-06 — Middleware fix: skip `/sw.js` + `/manifest.json`

Wave B deploy showed service-worker registration and PWA manifest
returning 307 from auth middleware. Both are public assets.

#### Fixed

- `src/middleware.ts` — Added `/sw.js`, `/manifest.json`, and
  `swe-worker-*` chunks to the matcher's negative-lookahead so
  middleware doesn't gate them.

### 2026-05-06 — Wave B: T-009 offline queue + T-012 compliance dashboard

Two parallel agents shipped the offline-resilience layer for the
operator iPad and the manager-side compliance dashboard.

#### T-009 — Offline queue + Service Worker (Serwist)

##### Added

- `src/app/sw.ts` — Serwist Service Worker, `cacheId: 'dr3-v1'`,
  skipWaiting + clientsClaim. Custom runtime caching: R2 photos
  `CacheFirst` 200/7d, operator data `NetworkFirst` 5s timeout / 5min.
  `BackgroundSyncPlugin` queues for upload endpoints + R2 PUT + Next.js
  server actions. 24h SW retention.
- `public/manifest.json` — PWA manifest (name DR3-Vision, start_url
  `/operator`, display standalone, theme_color `#00524C`).
- `src/lib/offline-queue.ts` — IndexedDB queue via `idb`. Two stores
  (`pending_uploads`, `pending_actions`). CRUD + `replayAll()` with
  capped exponential backoff, in-flight dedupe, conflict flagging.
- `src/app/operator/[site]/load/[id]/photo-input.tsx` — wraps R2 flow
  in try/catch; `isOfflineError` → enqueue + fire `onCaptured` with
  status `queued`.
- `src/app/operator/[site]/load/[id]/load-workflow.tsx` — registers
  mount sweep + `online` event listener + 30s `replayAll` tick + 5s
  `pendingCount` poll. `<PendingPill>` floats above stages; tap fires
  immediate replay.
- `src/app/operator/[site]/queue/page.tsx` — `<PendingBanner />`
  surfaces pending uploads with replay CTA.
- `src/types/serwist.d.ts` — ambient declaration for
  `ServiceWorkerGlobalScope.__SW_MANIFEST`.

##### Changed

- `next.config.js` — re-added `withSerwist` wrap (deferred from T-001).
  Adds `Cache-Control: max-age=0, must-revalidate` + `Service-Worker-Allowed: /`
  headers for `/sw.js`.
- `src/app/layout.tsx` — added `manifest`, `appleWebApp`, and `icons`
  to Next metadata.
- `.gitignore` — `/public/sw.js*` + `/public/swe-worker-*.js*` build
  artifacts.

##### Conflict resolution (per ADR-0006)

Network errors / 5xx → retried with backoff; hard 4xx → row flagged
`conflict:` in `last_error`. Subsequent replays skip conflict-flagged
rows so they don't auto-resolve under the operator. The pill keeps
the count visible so the operator knows something is stuck.

**Note:** iPad Safari does NOT implement Background Sync API (iPadOS 17).
The application queue at `src/lib/offline-queue.ts` is the primary path
on iPad; SW queues are belt-and-braces.

#### T-012 — Compliance dashboard

##### Added

- `src/lib/compliance.ts` — pure aggregation per metric.
  `(siteId, periodStart, periodEnd)` → `{ value, threshold, bucket, rowCount, clickThroughHref }`.
  `addBusinessDays()` helper pulls `site_holidays` and skips weekends + holidays. UTC-keyed, DST-safe.
- `src/app/dashboard/[site]/compliance/page.tsx` — `force-dynamic`,
  auth via `checkManagerForSite`, honors `?range`, `?from`, `?to`.
  `Promise.all`'d 7-tile grid.
- `src/app/dashboard/[site]/compliance/metric-tile.tsx` — single
  tile, whole-card Next `<Link>`. Color bands: green / yellow / red / pending.
- `src/app/dashboard/[site]/compliance/period-picker.tsx` — segmented
  range buttons + custom-range date inputs.

##### Metrics (7 tiles)

1. MyMRC submission timeliness
2. Processed-units submission (Pending V2.1)
3. Dock SLA (`time_to_unload_start_seconds` vs `dock_sla_minutes`)
4. Recycling rate (Pending V2.1)
5. Reconciliation rate (`mymrc_reconciliations` aggregate)
6. Storage inventory vs site limit (live computed)
7. Records retention (`MIN(arrived_at)` vs `records_retention_years`)

Every tile anchors to `/dashboard/[site]/loads?range=...&status=...`,
adopting T-011's URL vocabulary for click-through deep-links.

##### Verification

- `npm run lint` + `npm run typecheck` + `npm run build` all green.
- `/dashboard/[site]/compliance` emits as `ƒ` (982 B, 106 kB FLJS).

### 2026-05-06 — Wave A: T-010 dock view + T-011 load list + T-013 exports

Three Sprint-1 tickets shipped in parallel, integrated as one push.

#### T-010 — Manager live dock view

##### Added

- `src/app/dashboard/[site]/page.tsx` — dock grid with 5s router.refresh
  polling, paused-while-invisible via `useEffect` cleanup.
- `src/app/dashboard/[site]/dock-poller.tsx`, `dock-tile.tsx`, `elapsed-time.tsx` —
  reusable dock components with SLA color coding.
- `src/app/dashboard/[site]/load/[id]/page.tsx` — read-only manager
  load detail (header + photos + stacks + concerns + last-10 audit).

#### T-011 — Load list + filters + pagination

##### Added

- `src/app/dashboard/[site]/loads/page.tsx` — server-renders inbound loads
  for the manager's site, non-cancelled, ordered by expected arrival / state.
- `src/app/dashboard/[site]/loads/loads-filters.tsx` — URL-driven filters
  (`?range=`, `?site=`, `?status=`, `?from=`, `?to=`).
- `src/app/dashboard/[site]/loads/load-row.tsx`, `pagination.tsx`,
  `loads-poller.tsx` — support components for row rendering, pagination,
  and 30s polling.

#### T-013 — Export endpoints (MyMRC + SVdP)

##### Added

- `src/app/api/exports/mrc/route.ts` — POST exports inbound-load metrics
  to MyMRC (destination URL from `MYMRC_PUSH_*` env vars). Compressed,
  signed, timed payload.
- `src/app/api/exports/svdp/route.ts` — POST exports completed loads to
  SVdP (destination URL from `SVDP_EXPORT_*` env vars). Includes
  reconciliation + photo manifest.
- `src/app/dashboard/exports/page.tsx`, `ExportsClient.tsx` — manager
  surface to download CSV reports or trigger push exports.

##### Files

- NEW: `src/lib/auth-helpers.ts` — owns the canonical
  `requireManagerForSite` + `checkManagerForSite` shapes, shared by
  T-010, T-011, T-012, and export endpoints.

### 2026-05-06 — Cleanup: `.claude/worktrees` accidentally committed

Agent-dispatch infrastructure stores transient worktrees under
`.claude/worktrees/`. They were swept into the T-007 commit by broad
git-add. Removed from index and gitignored.

### 2026-05-06 — T-007: Photo capture + Cloudflare R2 upload

Replaces placeholder `storage_keys` with real R2 uploads via presigned URLs.

#### Added

- `src/lib/r2.ts` — R2 client using `@aws-sdk/client-s3` +
  `s3-request-presigner`. Auto region, force-path-style.
- `POST /api/photos/upload-url` — mints 10-min presigned R2 PUT URL +
  `storage_key` (path: `loads/<id>/<kind>/<uuid>.<ext>`).
- `POST /api/photos/confirm` — inserts `LoadPhoto` row after successful
  R2 PUT (confirmed by client).

#### Flow

Client → presigned URL → direct R2 PUT (no server proxy per CLAUDE.md #7)
→ confirm → DB insert.

Fallback when R2 unset: `mintUploadUrl` returns `{ storage_key: 'pending-r2-…', upload_url: '...' }`.

### 2026-05-06 — T-006: Seven-stage load workflow

Operator walks an inbound load through: BOL → weight → door-open
(timer) → decision (unload | reject) → counting (3 modes) → finish +
concern → submit (auto-logout).

#### Added

- `src/lib/load-service.ts` — state-machine transitions guarded
  server-side via `ALLOWED_PRIOR` map. Hand-crafted POSTs can't skip
  a stage.
- Per ADR-0012 §1: door-open capture stamps `unload_started_at`,
  computes `time_to_unload_start_seconds` (silent SLA metric), visible
  timer ticks against `unload_started_at`.
- `startInboundLoad` is idempotent (double-tap from queue returns the
  same load).

### 2026-05-06 — T-005: Expected-loads queue + auto/pull-to-refresh

Replaces post-PIN placeholder with the real operator queue.

#### Added

- `src/app/operator/[site]/queue/page.tsx` — server-renders
  `expected_loads` for the operator's site, non-cancelled, arriving
  today or later, ordered by `expected_arrival_at ASC`.
- Per row: arrival time (tabular-numerals for forklift glare), source,
  transporter, BOL, optional unit count.
- Empty state with "Last sync N min ago" caption pulled from
  `max(expected_loads.last_synced_at)`.
- Pull-to-refresh via `useScroll` + translucent pill.

### 2026-05-06 — T-004: Operator iPad PIN flow + bootstrap CLI

Brings up the operator-side auth path that T-005+ workflow tickets
ride on.

#### Schema

- `users.pin_first_failed_at DateTime?` for ADR-0004 sliding-window
  rate limit ("5 fails in 60s → 15min lockout").
- Migration: `20260506045516_pin_rate_limit_window`.

#### Added

- `src/lib/pin-service.ts` — Argon2id verify + sliding window + lockout.
  Lookup by `user_id` only (pin_hash stays un-indexed per CLAUDE.md #8).
  Success resets counters; failure runs ADR-0004 sliding window.
- `setPin()` — loop-verify uniqueness within site (ADR-0012 §3), never
  index the hash (CLAUDE.md #8).
- Bootstrap CLI (referenced in docs) — seeds initial operator users
  with PINs to the DB.
