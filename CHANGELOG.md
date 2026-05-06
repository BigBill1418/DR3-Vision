# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

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
