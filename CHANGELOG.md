# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

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
