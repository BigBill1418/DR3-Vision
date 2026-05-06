# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

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
