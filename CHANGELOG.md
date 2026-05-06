# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### 2026-05-06 — ADR-0016: Microsoft Entra ID SSO for managers + admins

Closes the post-Sprint-1 directive "entra only - sso only for admins
and managers." Operators are unaffected — PIN auth on the iPad stays.

#### Added

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
- `src/lib/__tests__/auth.signin-gate.test.ts` — 7 unit tests
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

#### Changed

- `src/app/login/login-form.tsx` — single "Sign in with Microsoft"
  CTA. Surfaces `error=AccessDenied` (gate-denied) and
  `error=Configuration` (env vars unset) as localized messages.
  Locale picker preserved. Per CLAUDE.md hard rule #10 the form
  uses `onClick`, not `<form>`.
- `src/middleware.ts` — `PUBLIC_PATHS` no longer lists
  `/forgot-password` or `/reset-password`.

#### Removed

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
- `auth_forgot.*` and the email/password keys (`email_label`,
  `email_placeholder`, `password_label`, `error_invalid`,
  `signing_in`, `submit`, `forgot`) under `auth_login.*` in all
  three locale dictionaries.

#### Vestigial — to be cleaned up in Sprint-2

- `users.password_hash` column. No code path reads or writes it
  after this change. A dedicated Sprint-2 migration will drop it.
  Left in place this sprint to keep the ADR-0016 PR free of
  irreversible schema work and rollback-able by `git revert` alone.

### 2026-05-06 — Post-Sprint-1: Admin Settings panel (`/admin/users`) — ADR-0017

First in-portal user-management surface. Replaces the bootstrap-CSV
seed for ongoing day-to-day adds, edits, deactivations, and
operator PIN resets. Bill's product call: "we will seed operator
accounts from within the settings panel in the portal — same place
I will add / seed other manager email accounts. entra only — sso
only for admins and managers."

#### Surface

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

#### API

- `POST /api/admin/users` — create.
- `GET /api/admin/users` — list (JSON).
- `PATCH /api/admin/users/[id]` — discriminated union by `action`:
  `update | reset_pin | deactivate | reactivate`.
- `DELETE /api/admin/users/[id]` — alias for `{action:'deactivate'}`.
- All endpoints gated to `role='admin'`. Manager + operator both
  return 403; anonymous returns 401. The middleware-level redirect
  is NOT trusted by the API.

#### Data + audit

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

#### Files

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

#### Verification

- `npx tsc --noEmit` clean
- `npx next lint --max-warnings 0` clean
- `npx vitest run` — 29/29 pass (10 PII-scrubber unit + 19 API
  integration with mocked Prisma + auth, real Argon2id hashing
  for the operator PIN-collision path).
- `npm run build` — admin routes compile, no client bundle drags
  in argon2 native binding (constants extracted).

#### Out of scope (deferred)

- Force-logout / session invalidation. Deactivation is the v1
  mechanism.
- Password reset email magic links — Resend not provisioned
  (Sprint-1 residual #2).
- Bulk import via UI — bootstrap CSV remains the canonical bulk
  path.
- Translating `/admin` strings — admin surface stays English-only
  for v1; literals concentrated in `src/app/admin/messages.ts` so a
  Sprint-2 pass is a single mechanical conversion.

### 2026-05-06 — Wave C: T-008 i18n (English / Spanish / Urdu)

Closes the last open Sprint-1 ticket. CLAUDE.md hard rule #4 — all
user-facing copy supports English, Spanish, and Urdu (RTL) on day 1
— is now satisfied for every operator surface.

#### T-008 — i18n architecture

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
  operator surface. English is the source. Spanish (Mexican) and
  Urdu (Nastaʿlīq script) are auto-translated and flagged for
  native review by SVdP staff in the file headers.
- `src/lib/format.ts` — `formatTime` / `formatDate` / `formatRelative`
  now accept an optional `locale` arg (default `en`). Maps:
  `en→en-US`, `es→es-MX`, `ur→ur-PK`. `Intl.DateTimeFormat` instances
  cached per-locale. `formatRelative` returns translated strings
  (`relative_time.*` keys).

#### Surfaces translated

- `src/app/operator/layout.tsx` (NEW) — wires the I18nProvider for
  the entire `/operator` route group.
- `src/app/operator/page.tsx`, `src/app/operator/[site]/page.tsx`,
  `src/app/operator/[site]/[userId]/page.tsx` — server-component
  headers / pickers translated.
- `src/app/operator/[site]/[userId]/keypad.tsx` — error messages,
  PIN-progress aria-label, switch-user link translated. Keypad grid
  forced `dir="ltr"` so digits stay 1-2-3 / 4-5-6 / 7-8-9 even under
  Urdu RTL.
- `src/app/operator/[site]/queue/page.tsx` — heading, signed-in-as
  caption, empty state, last-sync caption, BOL labels, approx-units
  count.
- `src/app/operator/[site]/queue/queue-client.tsx` — pull-to-refresh
  pill messages.
- `src/app/operator/[site]/queue/pending-banner.tsx` — pending count
  + sync-now / tap-to-replay (with plural variants).
- `src/app/operator/[site]/queue/sign-out-button.tsx` — switch-user
  label.
- `src/app/operator/[site]/load/[id]/page.tsx` — load detail header.
- `src/app/operator/[site]/load/[id]/load-workflow.tsx` — workflow
  status messages, pending-pill plural label.
- All seven stage components (`stage-bol`, `stage-weight`,
  `stage-door`, `stage-decision`, `stage-stacks`, `stage-reject`,
  `stage-finish`) — every visible string + select option +
  placeholder + error message translated.
- `src/app/operator/[site]/load/[id]/photo-input.tsx` — accepts a
  `labelKey` prop instead of a hard-coded `label`; looks up
  `photo.label_<labelKey>` and interpolates into the four button
  states (uploading / captured / queued / retry). Filename caption
  + queued caption also translated.

#### RTL handling

- `src/app/layout.tsx` — `<html lang>` + `<html dir>` set from the
  resolved locale via `dirFor()`. Tailwind's logical-property
  utilities (`ms-`/`me-`/`ps-`/`pe-`/`text-start`/`text-end`) flip
  layout automatically. Two operator-surface directional classes
  (`text-left` → `text-start`, `ml-3` → `ms-3`) converted in the
  queue + pending-banner.
- The PIN keypad, the unload timer's `mm:ss`, and the photo-input's
  filename caption are forced `dir="ltr"` regardless of page
  locale — numerals are universally LTR.
- `lang={locale}` set on the two textareas (`stage-finish`,
  `stage-reject`) so iPadOS dictation picks the right input
  language model. T-008 acceptance: "voice-to-text uses native
  iPadOS dictation; correctness is iPadOS's job, not ours."

#### Login locale picker

- `src/app/login/layout.tsx` (NEW) — provider wiring for `/login`.
- `src/app/login/locale-picker.tsx` (NEW) — three-button picker
  (English / Español / اردو) above the email input. Tapping fires
  `setLocaleAction()` and `router.refresh()`; the page re-renders
  in the new language without losing focus on the form.
- `src/app/login/page.tsx`, `src/app/login/login-form.tsx` —
  picker integrated; form copy + error message translated.

#### Auth — cookie → users.locale mirror

- `src/lib/auth.ts` — both Credentials providers (email-password +
  PIN) call `mirrorLocaleCookie(userId)` after a successful
  `authorize`. If the `dr3_locale` cookie is set and differs from
  the user's stored locale, write it through. Failures are
  swallowed — locale persistence is UX, not a security gate.

#### Out of scope (flagged follow-ups)

- **Manager portal i18n** (`src/app/dashboard/**`). Per the T-008
  charter call-out, only operator surfaces ship this sprint. The
  infrastructure is in place; a future ticket adds
  `src/app/dashboard/layout.tsx` + a `manager.json` namespace and
  threads the locale through the existing dashboard pages.
- **Forgot-password / reset-password copy translation.** Manager-
  adjacent surfaces; the locale picker on `/login` is enough for
  T-008's "locale picker on the login screen, persisted per-user"
  acceptance line. Translation can be added in the same follow-up
  ticket.
- **Server-side `<title>` metadata translation.** Comes from
  `metadata` exports; needs the i18n layer reachable from the
  metadata function. Deferred to the same follow-up.
- **Spanish + Urdu native review.** Both files carry top-level
  `_meta._comment_*` flags noting they're auto-translated. Bill /
  SVdP staff review before launch.

#### Architecture choice

ADR-0015 records why we ship a homegrown sync-import layer instead
of pulling `i18next` + `next-i18n-router` into the runtime. tl;dr:
the operator surface is small (~120 keys, ~3 KB gz / locale), the
App Router prefers synchronous server-side lookups, and
`next-i18n-router`'s `[locale]` segment would force a 30+ file URL
contract change for no measurable win.

`i18next` and friends remain in `package.json` from T-001; they are
unused at runtime (tree-shaken to zero) and stay available if a
future ticket needs CLDR plurals or ICU MessageFormat.

#### Verification

- `npm run lint` — clean (warnings are errors in this project).
- `npm run typecheck` — clean.
- `npm run build` — clean. Operator-page sizes:
  `/operator/[site]/load/[id]` 4.98 kB → 4.98 kB (no client growth;
  dictionary travels through RSC payload, not the client bundle).

### 2026-05-06 — Wave B: T-009 offline queue + T-012 compliance dashboard

Two parallel agents shipped the offline-resilience layer for the
operator iPad and the manager-side compliance dashboard.

#### T-009 — Offline queue + Service Worker (Serwist)

- `src/app/sw.ts` — Serwist Service Worker, `cacheId: 'dr3-v1'`,
  skipWaiting + clientsClaim. Custom runtime caching layered before
  `defaultCache`: R2 photos `CacheFirst` 200/7d, operator data
  `NetworkFirst` 5s timeout / 5min. `BackgroundSyncPlugin` queues
  for `/api/photos/upload-url`, `/api/photos/confirm`, R2 PUT, and
  Next.js server actions (matched by the `Next-Action` header for
  App Router). 24h SW retention.
- `next.config.js` — re-added the `withSerwist` wrap that T-001
  intentionally deferred. `swSrc: src/app/sw.ts`, `swDest:
  public/sw.js`, dev-disabled. Adds `Cache-Control: max-age=0,
  must-revalidate` + `Service-Worker-Allowed: /` headers for `/sw.js`.
- `public/manifest.json` — PWA manifest (name DR3-Vision, start_url
  `/operator`, display standalone, theme_color `#00524C`, icons
  pointing at the canonical logo per ADR-0014).
- `src/app/layout.tsx` — added `manifest`, `appleWebApp`, and `icons`
  to Next metadata.
- `src/lib/offline-queue.ts` — IndexedDB queue via `idb`. Two stores
  (`pending_uploads` keyed by ULID with `by-queued-at` + `by-load`
  indexes; `pending_actions` for queued server-action calls). CRUD
  helpers + `replayAll()` with capped exponential backoff
  (`min(2 ** attempts, 60)` seconds), in-flight dedupe, and
  conflict-flag preservation. `isOfflineError()` distinguishes
  network failure from hard 4xx.
- `src/app/operator/[site]/load/[id]/photo-input.tsx` — preserves the
  T-007 happy path verbatim. Each fetch (mint / R2 PUT / confirm)
  wraps in try/catch; `isOfflineError` → enqueue + still fire
  `onCaptured` with status `queued`. Top-of-file comment documents
  the server-side `LoadPhoto`-row gap until replay completes.
- `src/app/operator/[site]/load/[id]/load-workflow.tsx` — registers
  mount sweep + `online` event listener + 30s `replayAll` tick + 5s
  `pendingCount` poll. `<PendingPill>` floats above each stage when
  the count is > 0; tap fires immediate replay.
- `src/app/operator/[site]/queue/page.tsx` — `<PendingBanner />`
  inserted at the top of `<QueueClient>`; surfaces "N items pending
  upload from a previous shift — tap to replay".
- `src/types/serwist.d.ts` — single ambient declaration for
  `ServiceWorkerGlobalScope.__SW_MANIFEST` (build-time precache
  injection).
- `.gitignore` — `/public/sw.js*` + `/public/swe-worker-*.js*` build
  artifacts.

**Conflict resolution per ADR-0006:** network errors / 5xx → retried
with backoff; hard 4xx (load reassigned, session revoked, etc.) →
row stays in IndexedDB with `last_error` prefixed `conflict:`.
Subsequent replay passes SKIP conflict-flagged rows so they don't
auto-resolve under the operator. The pill keeps the count visible so
the operator knows something is stuck and can ask a manager. The
manager-portal "Discard" button + per-iPad queue-depth metric are a
T-010 follow-up.

**Sharp edges noted by the agent:** iPad Safari does NOT implement
the Background Sync API (iPadOS 17 as of writing) — the SW-side
`BackgroundSyncPlugin` queues are a no-op there. The application
queue at `src/lib/offline-queue.ts` is the primary path on iPad and
the SW queues are belt-and-braces. Critical for ADR-0006's "Replay
on connectivity recovery" acceptance — the application queue
(`online` event + 30s tick + page-mount sweep) is what actually
delivers it on iPad.

**Dockerfile** — no changes needed. `COPY --from=builder /app/public
./public` already picks up the new `manifest.json` + the
build-emitted `public/sw.js` + `public/swe-worker-*.js`.

#### T-012 — Compliance dashboard

- `src/lib/compliance.ts` — pure aggregation per metric. Each
  function takes `(siteId, periodStart, periodEnd)` and returns
  `{ value, threshold, bucket, rowCount, clickThroughHref }`.
  Per-site thresholds threaded via `MetricInput` — never hardcoded.
  `addBusinessDays(date, n, holidays)` helper pulls the site's
  `site_holidays` rows and skips weekends + holidays. UTC-keyed,
  DST-safe.
- `src/app/dashboard/[site]/compliance/page.tsx` — `force-dynamic`,
  auth via `checkManagerForSite` from the canonical `auth-helpers`,
  honors `?range`, `?from`, `?to` per T-011's URL contract,
  `Promise.all`'d 7-tile grid.
- `src/app/dashboard/[site]/compliance/metric-tile.tsx` — single
  tile, whole-card Next `<Link>`. Color bands: green
  `bg-dr3-green/20`, yellow `bg-orange-400/30`, red `bg-red-500/30`,
  pending `bg-dr3-cream/10`.
- `src/app/dashboard/[site]/compliance/period-picker.tsx` — segmented
  range buttons + custom-range date inputs, mirrors T-011's
  `loads-filters.tsx` shape.

**Per-metric formula + source:**

| # | Metric | Source | Status |
|---|---|---|---|
| 1 | MyMRC submission timeliness | `inbound_loads.mymrc_submission_deadline` vs `updated_at` of the status flip | Live |
| 2 | Processed-units submission | `processing_sessions` | Pending V2.1 (no writes yet) |
| 3 | Dock SLA | `inbound_loads.time_to_unload_start_seconds` vs `site.dock_sla_minutes` | Live |
| 4 | Recycling rate | needs recycled-weight column | Pending V2.1 |
| 5 | Reconciliation rate | `mymrc_reconciliations` aggregate | Live |
| 6 | Storage inventory vs site limit | `inbound_loads` on-site units vs `site.max_units_*` (live computed since `site_inventory_snapshots` writer not yet shipped) | Live |
| 7 | Records retention | `MIN(arrived_at)` vs `site.records_retention_years` | Live |

**Click-through deep-links:** every tile anchors to
`/dashboard/[site]/loads?range=...&status=...` adopting T-011's URL
vocabulary verbatim, so the "tap a tile → see the rows behind it"
acceptance criterion drops in cleanly.

**Verified post-integration:** `npm run lint` + `npm run typecheck` +
`npm run build` all green. `/dashboard/[site]/compliance` emits as
`ƒ` (982 B, 106 kB FLJS).

### 2026-05-06 — Wave A: T-010 dock view + T-011 load list + T-013 exports

Three Sprint-1 tickets shipped in parallel via worktree-isolated agents,
integrated into one push because they share `CHANGELOG` + `SPRINT-1-PLAN`
edits and a new shared auth helper. Each agent's report carried forward
known follow-ups (auth-helper re-pointing, status-label dedup, click-through
URL contract); those are tracked at the bottom of this entry.

#### T-010 — Live dock view

- `src/app/dashboard/[site]/page.tsx` — replaces the T-003 placeholder
  with the real per-site dock view. Server component queries `inbound_loads`
  filtered to operator-active states (`arrived` / `weight_captured` /
  `unload_started` / `in_progress` / `finished`), ordered by
  `arrived_at ASC`, with operator + source joined. 403 page preserved
  verbatim for off-site managers; `force-dynamic`; the placeholder's
  `generateStaticParams() => []` removed (was forcing the route into
  the SSG bucket — incompatible with polling + per-request session check).
- `dock-poller.tsx` — 5s `router.refresh()` interval with
  paused-while-in-flight guard and a small `Live · 5s` / `Live · refreshing…`
  pill (mirrors `queue-client.tsx` minus pull-to-refresh).
- `dock-tile.tsx` — server-rendered tile (Next `<Link>` to the detail
  page); operator name + source + BOL + status badge + live elapsed.
  Exports `stageLabel(LoadStatus)` re-used by the detail page; covers
  every enum value so TS catches a missing case if `LoadStatus` grows.
- `elapsed-time.tsx` — 1s tick rendering `mm:ss` (or `h:mm:ss` past 1h)
  in `font-mono tabular-nums`.
- `dashboard/[site]/load/[id]/page.tsx` (new) — read-only manager
  load detail: header + status + photos (storage_key listed; pending-r2
  flagged; presigned-GET preview is a follow-up) + stacks + concerns +
  last-10 audit rows. Same site-scope + 403 gate.

#### T-011 — Load list with filters

- `src/app/dashboard/[site]/loads/page.tsx` — server component, URL-driven
  filters → site-scoped Prisma `where`; rows + count in parallel; lookup
  dropdowns in parallel; `force-dynamic`. Default status filter is the
  manager-relevant post-operator subset (`submitted`, `verified`,
  `rejected`, `submitted_to_mymrc`, `processed`); the operator-active
  states are the dock view's territory.
- `loads-filters.tsx` — segmented range buttons (today / week / month /
  custom), custom-range date inputs, status toggle chips, three lookup
  `<select>`s (source / operator / transporter). Every change `router.push`es
  the URL with `page` reset to 1. Per CLAUDE.md hard-rule #10 buttons +
  selects + inputs, no `<form>`.
- `loads-poller.tsx` — 30s `router.refresh()` with an `aria-live`
  indicator dot.
- `load-row.tsx` — single row anchored to `/dashboard/[site]/load/[id]`
  (T-010 owns the destination); columns + colored status badge.
- `pagination.tsx` — Prev / "Page N of M" / Next as `<button>`s
  pushing the `page` param.
- The existing `@@index([site_id, status])` + `@@index([site_id, arrived_at])`
  on `inbound_loads` back the filter shape directly; pagination on 1000+
  loads handled server-side with `take` / `skip`.

#### T-013 — MRC + SVdP CSV exports

- `src/lib/exports.ts` (new) — RFC 4180 CSV emit, UTC half-open
  `monthRange`, MyMRC-verbatim column lists for the MRC export,
  MRC + 4 DR3-side provenance columns for the SVdP internal export.
  Five open questions (Q1–Q5) about column-shape decisions documented
  in the file header — for Bill to confirm or override before V2.1.
- `src/lib/auth-helpers.ts` (new, **canonical**) — `requireManagerForSite`
  (throws `Response`) + `checkManagerForSite` (returns tagged result).
  T-010 + T-011 page-level auth re-implements the same shape inline;
  re-pointing both to this helper is a small follow-up.
- `src/app/api/exports/mrc/route.ts` + `svdp/route.ts` — GET handlers
  with `?site=...&month=YYYY-MM`, `text/csv` + `attachment` content
  disposition, `Cache-Control: private, no-store`. Filters loads by
  `INVOICE_STATUSES` (the four billing-ready states) + `arrived_at`
  in the period.
- `src/app/dashboard/exports/page.tsx` + `ExportsClient.tsx` — manager
  picker UI; site dropdown (admin sees all, manager sees primary),
  `<input type="month">`, two anchor downloads with `href` driven by
  client state. Per CLAUDE.md hard-rule #10 no `<form>`.
- Column choice rationale: MyMRC verbatim names per ADR-0012 §7
  ("MyMRC field-name shape"), not snake_case — Glenn DePrater reshape
  is Sprint-2+.

#### Cross-cutting follow-ups (carried from agent reports)

- **Auth-helper re-point** — T-010's `dashboard/[site]/page.tsx` and
  T-011's `dashboard/[site]/loads/page.tsx` re-implement the
  manager-for-site check inline; convert both to `requireManagerForSite`
  / `checkManagerForSite` from `src/lib/auth-helpers.ts` in a small
  follow-up after T-012 also lands its dashboard page using the helper.
- **Status-label dedup** — `STATUS_LABELS` / badge classes appear in
  T-010's `dock-tile.tsx` AND T-011's `loads-filters.tsx` /
  `load-row.tsx`. Hoist to `src/lib/load-status.ts`
  (`displayLabel(LoadStatus)` + `badgeClass(LoadStatus)`) so T-008 has
  exactly one i18n hook to translate.
- **Click-through URL contract** — T-012 compliance dashboard tiles
  deep-link into `/dashboard/[site]/loads?...`; the URL vocabulary
  (`range=today|week|month|custom`, `from`/`to`, `status=`) is
  established by T-011 and the T-012 agent should adopt it verbatim.
- **`site_inventory_snapshots` writer** — T-012 metric #6 (storage
  inventory vs site limit) needs a snapshot writer. None exists yet
  (write-on-load-finish or cron). Brief T-012 agent on this.
- **`system_state.last_mymrc_scrape_at`** — T-012 metric #1 (MyMRC
  submission timeliness) wants a real scrape timestamp; current
  approximation is `max(expected_loads.last_synced_at)` per the T-005
  queue page. Same approximation works for T-012 until T-013 (or a
  later ticket) writes a system_state row.

**Verified post-integration:** lint + typecheck + build green; new
routes `/dashboard/[site]/loads`, `/dashboard/[site]/load/[id]`,
`/dashboard/exports`, `/api/exports/mrc`, `/api/exports/svdp` emit
as `ƒ` (dynamic).

### 2026-05-06 — T-007: Photo capture + Cloudflare R2 upload

Sprint-1 ticket T-007. Replaces the T-006 placeholder `storage_key`s
with real R2 uploads via presigned URLs.

**Flow:**

1. Operator taps the camera button → file picker / iPad rear camera
2. Client POSTs `/api/photos/upload-url` → server mints a 10-minute
   presigned R2 PUT URL + `storage_key` (`loads/<id>/<kind>/<uuid>.<ext>`)
3. Client PUTs the file bytes directly to R2 — server never proxies
   the bytes (CLAUDE.md hard rule #7)
4. Client POSTs `/api/photos/confirm` → server inserts the `LoadPhoto`
   row with the real `storage_key` + byte size
5. `onCaptured` fires → parent stage's "Continue" button enables

**R2 client** (`src/lib/r2.ts`): wraps `@aws-sdk/client-s3` +
`@aws-sdk/s3-request-presigner` for the Cloudflare R2 endpoint
(`https://<account>.r2.cloudflarestorage.com`, region `auto`,
force-path-style). Cached client; 10-min URL TTL; safe extension
mapping for jpeg/png/webp/heic/heif → `bin` fallback.

**Fallback when R2 not yet provisioned:** if the four R2 env vars
are unset, `mintUploadUrl` returns `{ storage_key:
'pending-r2-<kind>-<uuid>.<ext>', upload_url: null }`. The client
detects `null` and skips the PUT but still calls `/api/photos/confirm`
so the workflow row count stays correct (matches the T-006 placeholder
semantics). This keeps the operator flow unblocked during the
operator-residual window before R2 creds land.

**Auth guard** (`src/lib/load-photo-guard.ts`):
`requireOperatorOwnsLoad(loadId)` — session role must be operator,
load must be assigned to that operator, operator's `primary_site_id`
must equal the load's `site_id`. Throws a `Response` for the route
handlers to return directly. Used by both `/api/photos/upload-url`
and `/api/photos/confirm`.

**Service-layer cleanup:** the four operator-stage server actions
(`recordBolCapture`, `recordWeightCapture`, `recordDoorOpenCapture`,
`rejectLoad`) no longer call `attachPhoto` themselves — that would
double-insert now that the client writes the row pre-action.
`attachPhoto` is left exported as a server-side helper for future
batch / backfill paths.

**Compose + Dockerfile:**

- `docker-compose.yml` app service gets an optional `r2.env` env_file
  (Compose v2 `path` + `required: false`); falls back gracefully if
  the file doesn't exist yet.
- Runner stage adds `node_modules/@aws-sdk` + `node_modules/@smithy`
  COPY lines so the AWS SDK's optional sub-imports are present at
  runtime (the Next.js standalone bundle covers the main paths but
  optional client transports trip the same trap as papaparse did in
  T-002).

**Annotation tool** (in-browser circle/arrow/freehand/text overlay
per SPRINT-1-PLAN T-007 line) is intentionally deferred. The schema
already carries `LoadPhoto.annotation_storage_key` ready for the
two-blob upload pattern; the UI canvas + the annotation-confirm
endpoint ship in a follow-up. Flagged in CHANGELOG but not blocking
Sprint-1 completion (operator can still describe issues via the
finish-stage concern note).

**Operator residual:**
`~/.dr3-vision-secrets/r2.env` (mode 600 on HSH-HQ + CHAD-HQ) needs:

```
R2_ACCOUNT_ID=<cloudflare account id>
R2_ACCESS_KEY_ID=<r2 access key id>
R2_SECRET_ACCESS_KEY=<r2 secret access key>
R2_BUCKET=dr3-vision-photos
R2_PUBLIC_BASE_URL=https://photos.dr3-vision.svdp.us
```

R2 bucket + public custom domain provisioning is operator
click-through (the on-file CF API tokens lack R2 admin scopes).

**Verified:** lint + typecheck + build green; new routes
`/api/photos/upload-url` + `/api/photos/confirm` emit as ƒ.

### 2026-05-06 — T-006: Seven-stage load workflow

Sprint-1 ticket T-006 — the meatiest ticket on the board. Operator
walks an inbound load through BOL → weight → door-open (timer) →
decision (unload | reject) → counting (3 modes) → finish + concern →
submit (auto-logout). Photo bytes still go nowhere — T-007 wires R2;
for T-006 each captured photo writes a `load_photos` row with a
placeholder `storage_key` and the UI gates "Continue" until a file is
in client state.

**Data layer** (`src/lib/load-service.ts`):

- State-machine transitions guarded server-side via an `ALLOWED_PRIOR`
  map, so a hand-crafted POST cannot skip a stage. UI enforces order;
  service rejects illegal moves.
- Per ADR-0012 §1 `unload_started_at` is stamped by the door-open
  capture (not BOL); `time_to_unload_start_seconds` is captured
  silently for the Article 11.3 SLA dashboard; `unload_duration_seconds`
  is the visible operator timer.
- `startInboundLoad` is idempotent — taps from the queue twice
  return the same in-flight `InboundLoad`.
- `submitLoad` + `rejectLoad` both stamp `submitted_at` +
  `submitted_by_id`; rejection writes `rejection_category` +
  `rejection_note` + a `rejection` photo row.
- Audit rows on every state transition + on initial create.

**Server actions** (`src/app/operator/[site]/actions.ts`):

- One thin wrapper per service call. Each re-derives operator + site
  from the active session — no client-trusted IDs. Submit + reject
  end with `signOut({ redirect: false })` then redirect back to the
  name picker (ADR-0004 auto-logout on submission).

**Workflow shell + stages**
(`src/app/operator/[site]/load/[id]/`):

- `page.tsx` — server component, hydrates load + dispatches.
- `load-workflow.tsx` — client dispatcher; visible stage is a
  function of `load.status` plus a tiny client flag for the
  weight-decision sub-stage (Add vs None both leave the load on
  `arrived` so the server status can't disambiguate).
- `stage-bol.tsx`, `stage-weight.tsx`, `stage-door.tsx`,
  `stage-decision.tsx`, `stage-stacks.tsx`, `stage-reject.tsx`,
  `stage-finish.tsx` — one stage each. All onClick handlers (no
  `<form>` per CLAUDE.md hard rule #10).
- `photo-input.tsx` — touch-first camera invocation
  (`<input type="file" capture="environment" accept="image/*">`).
  File is held in client state; T-007 swaps in the actual upload.
- Stage 5a (counting) implements all three modes per charter §4.3:
  - **ledger** — single big "+1" button
  - **multiplier** — "Mattresses in this stack" → "Add stack"
  - **total** — "Total mattresses on this load"
    Visible timer ticks since `unload_started_at` in the bottom bar.

**Queue tap-to-start** (`src/app/operator/[site]/queue/queue-row.tsx`):

- Each queue row is a `<button>` (no `<form>`) that calls
  `startLoadAction(siteCode, expectedId)`. The action creates the
  `InboundLoad` and redirects to `/operator/[site]/load/[id]`.

**Verified:** lint + typecheck + build green; new route
`/operator/[site]/load/[id]` emits at 4.43 kB ƒ. End-to-end
(queue → BOL → weight skip → door-open → unload → 1+ stacks →
finish → submit) verified after deploy + walk-through.

### 2026-05-06 — T-005: Expected-loads queue (operator surface)

Sprint-1 ticket T-005. Replaces the post-PIN placeholder with the real
queue the operator works against during a shift.

**Surface** (`src/app/operator/[site]/queue/page.tsx`):

- Server component reads `expected_loads` for the operator's site,
  filtered to non-cancelled rows arriving today or later, ordered by
  `expected_arrival_at ASC`.
- Each row: arrival time (large, tabular-numerals — easy to read on a
  forklift mount under glare), source name (resolved through the
  `Source` FK with the raw `source_name_at_sync` as fallback for
  pre-reconcile rows), transporter name (same fallback pattern), BOL
  number, optional `~N units`.
- Empty state: "No loads expected today" + last-sync caption derived
  from `max(expected_loads.last_synced_at)` for the site. T-013 ships
  the actual MyMRC scrape; until then `last_synced_at` is whatever
  the test seeder wrote.
- Per ADR-0014 this is the first OPERATOR working surface — green
  palette (`bg-dr3-green-deep` / `text-dr3-cream`), not the auth-screen
  black. The pre-PIN routes (name picker, keypad) keep the dark +
  canonical-logo treatment per the ADR; the queue is where the work
  begins.

**Refresh paths** (`queue-client.tsx`):

- **Auto-refresh every 60 s** — `router.refresh()` re-runs the server
  component without a hard navigation. Tick is paused while a refresh
  is already in flight to avoid stacking.
- **Pull-to-refresh** — touch handler engages from `scrollY === 0`,
  threshold 80 px, with linear-then-resistant pull math so the
  indicator doesn't fly off-screen on overshoot. A pill at the top of
  the list shows "Pull down" → "Release to refresh" → "Refreshing…"
  state. Handles iPad Safari standalone-PWA mode where the
  browser-native pull-to-refresh isn't installed.

**Format helpers** (`src/lib/format.ts`):

- `formatTime`, `formatDate`, `formatRelative`. Locale defaults to
  `en-US`; T-008 wires the user's stored locale in once Spanish + Urdu
  ship.

**Acceptance:** `npm run lint`, `npm run typecheck`, `npm run build`
all green; `/operator/[site]/queue` emits as ƒ (dynamic, 1.03 kB).
End-to-end against production verified after deploy + a small batch
of test `ExpectedLoad` rows seeded for Woodland.

### 2026-05-06 — T-004: Operator iPad PIN flow

Sprint-1 ticket T-004. Brings up the operator-side auth path that
T-005+ workflow tickets ride on.

**Schema:**

- New `users.pin_first_failed_at DateTime?` column for the ADR-0004
  sliding-window rate limit ("5 failed attempts in 60 seconds → 15-min
  lockout"). Migration `20260506045516_pin_rate_limit_window`.

**PIN service** (`src/lib/pin-service.ts`):

- `verifyPin(userId, pin)` — Argon2id verify + sliding-window rate
  limit + lockout. Lookup is by `user_id` only (PIN-enumeration
  hardening; `pin_hash` stays un-indexed per CLAUDE.md hard rule #8).
  Successful verify resets the failure counter and stamps
  `last_login_at`. Lockout sets `pin_locked_until` to `now + 15min`.
- `setPin({ targetUserId, pin, actorUserId })` — runs the
  loop-verify uniqueness check across all active operators at the
  target's site (ADR-0012 §3 — ~30 verifies × ~80ms ≈ 2.5s
  acceptable for admin-side; rejects on collision). On success writes
  the new hash, clears all rate-limit state, and writes an audit row
  via the shared helper. The PIN itself is never stored or logged —
  only `pin_hash: '<argon2id>'` lands in audit.

**PIN policy** (`src/lib/pin-validator.ts`):

- 4 numeric digits, no all-same (0000 / 1111), no sequential (1234 /
  4321 / 0123), no repeated-pair (1212 / 3434). Per ADR-0004 §Policy.

**Audit helper** (`src/lib/audit.ts`):

- `writeAudit({...})` — append-only insert into `audit_log`. Wraps
  Prisma's NULL/undefined Json semantics so callers don't have to
  remember `Prisma.JsonNull`.

**Auth wiring:**

- New `pin` Credentials provider in `src/lib/auth.ts` alongside the
  existing email-password `credentials` provider. `signIn('pin', {
user_id, pin })` from the keypad client component.
- `src/lib/auth.config.ts` — per-role idle timeout: operators get
  5 min (ADR-0004 auto-logout), managers/admins keep the 12h from
  T-003. Both roles share the 30d absolute cap.

**Operator surfaces** (per ADR-0014 dark + canonical-logo treatment;
per CLAUDE.md hard-rule #10 keypad uses `onClick` handlers, no
`<form>`):

- `/operator` — site picker (only used when the iPad isn't
  pre-pinned to a site; T-005+ adds the per-device site cookie).
- `/operator/[site]` — name picker. Lists active operators at that
  site, sorted last-seen-recent first (`last_login_at` DESC NULLS
  LAST), then by name.
- `/operator/[site]/[userId]` — keypad page. Touch-first numeric
  pad, 4-dot progress indicator, backspace, auto-submit on the 4th
  digit (no separate submit; gloved-hand minimum-tap UX).
- `/operator/[site]/queue` — placeholder post-PIN landing. Real
  expected-loads UI lands in T-005. Carries the "Switch user"
  sign-out control.

**Middleware** — `/operator` and `/operator/*` are pre-auth surfaces;
the queue route does its own server-side `auth()` check + role +
site-scope enforcement.

**Bootstrap CLI** (`scripts/set-operator-pin.mjs`):

- `node scripts/set-operator-pin.mjs <site-code> <operator-name> <pin>`
- Find-or-create the operator at the given site, run the loop-verify
  uniqueness check, hash with Argon2id, write the audit row. Used
  to seat the T-004 acceptance test operator + as the manager-side
  fallback until the manager-portal PIN-reset surface ships (T-010+).

**Verified:** lint + typecheck + build green; all operator routes
emit as ƒ (dynamic) since each one queries Prisma. End-to-end
acceptance — "Test operator with PIN 4738 can log in, perform a
no-op session, logout. Lockout triggers correctly. Reset flow
audit-logged" — verified after the deploy + bootstrap of the test
operator.

### 2026-05-06 — Sprint-1 completion: Auth, deployment fixes, brand lock

**T-003: Auth.js v5 email-password login + role gating + reset flow**

Sprint-1 ticket T-003. Closes the auth foundation T-005+ portal tickets need.

**Auth core:**

- `src/lib/auth.ts` — Auth.js v5 (next-auth@5.0.0-beta.22) full Node
  config with a Credentials provider that authenticates against
  `users.password_hash` via Argon2id (`src/lib/argon.ts`). Rejects the
  seed sentinel `pending_first_password_reset` so unfinished accounts
  can't sign in. JWT session, 30-day absolute max + 12-hour idle
  enforced in the `jwt` callback by tracking `last_seen_at`.
- `src/lib/auth.config.ts` — edge-safe base config (no providers, no
  Prisma) shared by middleware. Splitting the config keeps Prisma out
  of the edge runtime.
- `src/middleware.ts` — auth-gates everything except `/`, `/login`,
  `/forgot-password`, `/reset-password`, `/healthz`, `/api/auth/*`,
  static assets. Anonymous → 302 to `/login` with a `?next=` param
  preserving the requested path.
- `src/types/next-auth.d.ts` — module augmentation for `User`,
  `Session`, `JWT` to carry `role` + `primary_site_id`.

**Login + reset surfaces** (per ADR-0014: dark bg + canonical logo on
auth routes; per CLAUDE.md hard-rule #10: `onClick` handlers, no
`<form>` element):

- `/login` — email + password, `signIn('credentials')`,
  redirect to `?next=` or `/dashboard`. Suspense boundary wraps the
  client form because of `useSearchParams()`.
- `/forgot-password` — POSTs to `/api/auth/forgot-password`. Always
  returns the same UI confirmation regardless of whether the email is
  in the system, so the form can't be used as an account-existence
  oracle.
- `/reset-password?token=...` — accepts the HMAC-signed token, sets
  the new password (≥ 12 chars), marks the user `is_active=true`.

**Stateless reset tokens** (`src/lib/password-reset-token.ts`):

- HMAC-SHA-256 over `${user_id}.${expires_at_unix}.${nonce}` using
  `NEXTAUTH_SECRET` as the key. 15-minute TTL. Rotating
  `NEXTAUTH_SECRET` invalidates outstanding reset links along with
  all sessions — same blast radius, intentional.
- `timingSafeEqual` on the signature compare. No DB row needed —
  trade-off documented inline.

**Email** (`src/lib/email.ts`):

- Direct fetch to Resend's REST API (no SDK package). If
  `RESEND_API_KEY` is unset the sender logs to stdout and resolves —
  keeps the bootstrap path usable before the API key is provisioned
  (operator drops it into `~/.dr3-vision-secrets/auth.env` later).

**Acceptance harness** (T-003 line says manager must be 403'd from
the wrong site):

- `/dashboard` lists sites visible to the signed-in user (admin
  sees both; manager sees only their `primary_site_id`).
- `/dashboard/[site]` enforces site scoping at the route handler;
  returns a 403 page with a link back to `/dashboard` when a manager
  hits a site that isn't theirs.
- T-005+ replaces these placeholders with the real operator queue +
  manager dock view; the gating moves into shared helpers.

**Bootstrap CLI** (`scripts/set-password.mjs`):

- One-shot tool to seat a manager/admin password without going
  through the email-reset flow. Reads new password from a TTY prompt
  (no echo), writes the Argon2id hash, marks the account
  `is_active=true`. Used post-deploy to bring up Bill's account so
  the email-reset flow can be tested for the rest of the team once
  Resend is wired.
- Usage:
  `docker compose run --rm migrate node scripts/set-password.mjs operations@svdp.us`

**Secrets** — new `~/.dr3-vision-secrets/auth.env` (mode 600) on
HSH-HQ + CHAD-HQ:

- `NEXTAUTH_SECRET` — base64-encoded 32-byte random; signs JWTs and
  password-reset tokens.
- `NEXTAUTH_URL=https://dr3-vision.svdp.us`
- `RESEND_API_KEY` — empty until operator provisions; sender
  stub-logs.
- `EMAIL_FROM=no-reply@dr3-vision.svdp.us`

App service in `docker-compose.yml` now sources both `db.env` and
`auth.env`.

**Verified:** lint + typecheck + build green. End-to-end against
production deferred until operator runs the bootstrap CLI to set the
admin password (no working credentials exist in the seeded DB by
design — every seeded user has the `pending_first_password_reset`
sentinel hash).

**T-002: Prisma init migration + seed loader + production Postgres**

Sprint-1 ticket T-002 (`docs/SPRINT-1-PLAN.md`). Closes the database
foundation that T-003+ tickets depend on.

**Schema:**

- Added `verified` to `LoadStatus` enum between `submitted` and
  `submitted_to_mymrc` per ADR-0012 §2 (manager-verified gate before
  MyMRC submission). All other enum positions preserved so existing
  test fixtures keep their ordinal mappings.
- `prisma format` reflowed the schema's column alignment but no
  semantic changes.

**Migration:**

- First migration generated as `prisma/migrations/20260506014249_init/`.
  Created against a temp Postgres 16 container; 30 tables / 13 enums
  / all indexes + FKs from the draft DDL land on a fresh DB.
- Production runs `prisma migrate deploy` via a one-shot `migrate`
  init container in `docker-compose.yml` (idempotent; depends on
  `postgres: service_healthy`; the app's `depends_on` blocks on
  `migrate: service_completed_successfully` so a failed migration
  aborts the deploy at the gate rather than booting the app against
  a stale schema).

**Seed loader (`prisma/seed.mjs`):**

- Reads the six CSVs in `prisma/seed/` (Papa Parse) and idempotently
  upserts in dependency order: sites → transporters → users →
  site_holidays → processor_bonus_rules → sources.
- Match keys per `prisma/seed/README.md`: `code` (sites), `name`
  (transporters), `email` (users), `(site_id, holiday_date)`
  (holidays), `(site_id, effective_date)` (bonus rules — emulated
  via findFirst since no composite-unique declared on the schema),
  `(site_id, name)` (sources).
- Verification: at end of seed, asserts row counts against the
  contract in `prisma/seed/README.md` (sites=2, users=5,
  site_holidays=24, processor_bonus_rules=2, sources=111,
  transporters=11). Mismatches throw and abort.
- Fixed `processor_bonus_rules.csv` — `notes` column contained
  unquoted commas (`MAX(units - 50, 0)`), Papa Parse rejected as
  field-count mismatch; quoted both rows.
- `package.json` gets `"prisma": { "seed": "node prisma/seed.mjs" }`
  so `npx prisma db seed` works from any directory without runtime
  deps. Converted from `seed.ts` → `seed.mjs` to drop the tsx dev-only
  dependency from production images.

**Production Postgres:**

- New `postgres` service in `docker-compose.yml` (postgres:16-alpine,
  named volume `dr3-vision_postgres-data`). Credentials in
  `~/.dr3-vision-secrets/db.env` (mode 600) on HSH-HQ + CHAD-HQ;
  randomly generated 40-char alphanumeric password, never committed.
- App's `DATABASE_URL` switched from build-time placeholder to a
  real connection string (sourced via `env_file` from db.env).
- Dockerfile runner stage now copies `node_modules/prisma`,
  `node_modules/@prisma`, and `node_modules/.bin/prisma` from the
  builder, plus `node_modules/papaparse` (needed by seed.mjs) so the
  `migrate` init container can run `npx prisma migrate deploy`.
- Prisma invoked via explicit module path in Dockerfile to avoid
  symlink COPY issues that broke WASM resolution at runtime.

**Healthz contract:**

- `/healthz` adds `db_ok` (boolean) per ADR-0013 §4. Probes the DB
  with `SELECT 1` via Prisma; returns 503 if it fails.
- New `src/lib/prisma.ts` singleton — survives Next.js HMR in dev,
  shares a connection pool in prod.

**Verified locally:** spun up a temp Postgres 16 container on port
5435, ran `prisma migrate dev --name init` + `npm run db:seed` twice
(idempotency check) — both runs report exact target row counts.

**Operator follow-up (not in T-002):** initial production seed must
run by hand once the migrate container shows green. SSH to CHAD-HQ
and run `docker compose run --rm migrate node prisma/seed.mjs` (or
similar one-shot using the same image). HANDOFF.md "Production
seeding" section is the canonical reference.

**ADR-0014: Canonical brand mark + dark-mode auth lock**

`public/brand/dr3-vision-logo.jpg` is the canonical DR3-Vision mark,
used wherever a brand mark appears. Auth surfaces (placeholder
`/login`, T-003) use `bg-black` to match the mark's space backdrop;
operator + manager working surfaces stay on `--dr3-green-deep` per
ADR-0008. Cyan accent in the logo is asset-internal and does NOT
become a tailwind token. Closes ADR-0012 §5 + HANDOFF open decision
#1. CLAUDE.md hard-rules section gets a new rule #11 enshrining the
brand-mark + auth-bg lock.

**Compose restructure** (incident recovery):

Production compose moved from `deploy/docker-compose.yml` to root
`docker-compose.yml`; the previous root dev compose moved to
`docker-compose.dev.yml`. Driver was a deploy incident: the noc
swarmpilot deployer's remote-deploy code path (compose stacks on
non-HQ hosts) does NOT honor the `compose_file:` config knob — only
the local-deploy path does. So when the deployer ran
`docker compose up -d` on CHAD-HQ after the prior push it hit the DEV
compose at root, started the dev MinIO container, and tore down
`dr3-vision-cloudflared` as an "orphan" — knocking the tunnel down and
returning HTTP 530. Recovery: manual `docker compose down --remove-orphans`

- rebuild + up against the prod compose. Permanent fix: this restructure,
  plus updated comments at the top of `docker-compose.yml` explaining why
  it MUST be the production file. README.md and HANDOFF.md updated to
  invoke the dev compose explicitly with `-f docker-compose.dev.yml`.
  ADR-0013 §1 already records the structural choice.

**Canonical logo wired in:**

Bill provided the canonical DR3-Vision logo
(`public/brand/dr3-vision-logo.jpg`, 1168×784) — eye-as-"o" treatment
in cyan on a dark space backdrop. The placeholder page now shows the
logo image as the hero with "— coming soon" beneath, on a black
background that matches the logo's backdrop. Background change is
scoped to the placeholder route only; layout-level body bg stays on
`--dr3-green-deep` per ADR-0008. The earlier inline-SVG eyeball + text
wordmark are removed. Footer caption under the SVdP seal swapped to a
`svdp.us` hyperlink at Bill's request. Also added the SVdP seal as a
small footer credit (72×72 PNG, rendered via next/image with priority
for LCP).

**T-001 follow-up: deployable to CHAD-HQ**

Lands the production deploy surface for the T-001 placeholder.

- New `/healthz` route at `src/app/healthz/route.ts`. Returns
  `{ ok, version, uptime_s }` with HTTP 200. Hit by the Dockerfile
  HEALTHCHECK, the swarmpilot post-deploy smoke probe, and the
  per-tunnel CF Healthcheck. The response shape grows toward the
  contract in `docs/FLEET-DEPLOYMENT.md` §"Healthcheck" as T-002 / T-007
  bring DB + R2 online.
- Production stack: `app` (Next.js standalone) + `cloudflared` sidecar
  bound to the dedicated `dr3-vision` tunnel
  (UUID `3999bb3b-7f86-4896-8f8c-77ef27f8f2cf`). Per ADR-0008
  (svdp-intranet), each service gets its own tunnel and the cloudflared
  sidecar lives inside the compose so rollback is atomic with the app
  rollback. Cloudflared image pinned to `2026.3.0` (fleet standard).
- Dockerfile: provide a syntactically valid placeholder `DATABASE_URL`
  for `npx prisma generate` at build time. The client-generation step
  only parses the schema; runtime gets the real URL from the
  orchestrator. This unblocks builds before the T-002 migration lands.
- Tunnel created via CF API; ID + token persisted at
  `~/.dr3-vision-secrets/tunnel.env` on HSH-HQ (mode 600) and
  replicated to CHAD-HQ at the same path before first compose-up.
- DNS: `dr3-vision.svdp.us` CNAME → `<tunnel>.cfargotunnel.com`,
  proxied (record id `61c5ca00fabbd7a759a1af3fe3211327`).

### 2026-05-05 — T-001: Repo scaffold

Sprint-1 ticket T-001 (`docs/SPRINT-1-PLAN.md`).

- Added `src/app/{layout,page}.tsx` + `globals.css`. Placeholder landing
  renders "DR**3**-Vision — coming soon" with `--dr3-green-deep` background,
  the "3" tinted `--dr3-green`, and `--dr3-chartreuse` subtitle, in Inter
  loaded via `next/font/google` (per ADR-0012 §5 + SPRINT-1-PLAN T-001).
- Mapped shadcn CSS variables to the DR3 brand palette in `globals.css`
  (per ADR-0008). Component work in later tickets reads these tokens.
- Replaced `next-pwa@5.6.0` with `serwist@^9 + @serwist/next + @serwist/background-sync`
  per ADR-0012 §4. Service Worker wiring and runtime caching rules are
  deferred to T-009 (offline queue); next.config.js carries a TODO with the
  legacy caching shape for that swap.
- Bumped `next` and `eslint-config-next` from 15.0.0 → 15.5.15 to clear
  CVE-2025-66478 (critical). Remaining audit advisories are 10 moderate
  - 2 low, all transitive — to be reviewed in a dedicated dependency pass.
- Added `output: 'standalone'` to `next.config.js` to match Dockerfile
  expectations (line 51 already copies `.next/standalone`).
- Added ESLint flat config (`eslint.config.mjs`) bridged to
  `next/core-web-vitals` + `next/typescript` via `@eslint/eslintrc` FlatCompat.
  `npm run lint` runs `next lint --max-warnings 0`. Note: `next lint` is
  slated for removal in Next 16; migrate to `eslint .` as a follow-up.
- Added Prettier (`.prettierrc.json`, `.prettierignore`) with
  `printWidth: 100`, single quotes, and `prettier-plugin-tailwindcss`.
- Added Husky pre-commit hook (`.husky/pre-commit` runs `npx lint-staged`).
  `lint-staged` config already in `package.json`.
- Added `postcss.config.js` for Tailwind v3.
- Added `public/.gitkeep` so the directory exists for Next.js + Dockerfile copy.

**Acceptance verified:**

- `npm run lint` → "No ESLint warnings or errors"
- `npm run build` → "Compiled successfully in 14.2s", 4 static pages,
  102 kB First Load JS
- `npm run typecheck` → clean
- `npm run dev` → HTTP 200 on `/`; HTML contains expected brand tokens
  (`bg-dr3-green-deep`, `text-dr3-green` on the "3", `text-dr3-chartreuse`
  on the subtitle, `--font-inter`)

**Operator note:** the brand-correctness checkpoint in SPRINT-1-PLAN T-001
("if the colors are wrong, T-001 isn't done") requires visual confirmation
in a real browser. The HTML carries the right Tailwind classes; please
open `http://localhost:3000/` after `npm run dev` and confirm the color
rendering matches the brand intent before T-002 begins.

**Next:** T-002 — Prisma migration with the `verified` LoadStatus enum
addition per ADR-0012 §2 + seed loader for the six CSVs in `prisma/seed/`.
