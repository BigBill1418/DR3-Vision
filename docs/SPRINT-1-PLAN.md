# Sprint 1 plan

The acceptance criteria here are the contract for "MVP". When all unblocked tickets are green, Sprint 1 ships.

Tickets are ordered by dependency. Take them in order. Mark them `[x]` as you complete them; do not reorder.

## Foundation (must finish before anything else)

### [x] T-001: Repo scaffold

- Next.js 15 App Router, TypeScript strict mode, Tailwind, shadcn/ui initialized
- ESLint configured: warnings are errors (`--max-warnings 0`)
- Prettier configured with `printWidth: 100`
- Husky + lint-staged for pre-commit checks
- The placeholder page at `/` shows "DR3-Vision — coming soon" rendered in the DR3 brand palette (deep green background, chartreuse accent, Inter typography). This is the brand-correctness checkpoint — if the colors are wrong, T-001 isn't done.

**Acceptance:** `npm run dev` serves a brand-correct placeholder. `npm run lint` and `npm run build` both green.

### [x] T-002: Prisma schema, first migration, seed loader

- Translate `prisma/schema.prisma` into a working migration
- Write the seed loader that reads the CSVs in `prisma/seed/*` and idempotently inserts/updates
- Document the seed precedence (sites → users → site_holidays → processor_bonus_rules → sources → transporters)

**Acceptance:** `docker compose up -d postgres && npx prisma migrate dev --name init && npx prisma db seed` reaches a clean state with all expected row counts (see `HANDOFF.md` Step 3).

### [x] T-003: Auth.js v5 — manager/admin email-password flow

- Email + password login at `/login`
- Session cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, 12-hour idle, 30-day absolute
- Argon2id password hashing
- Password reset flow via email (use Resend or similar — env-configurable)
- Role gating middleware (`operator`, `manager`, `admin`)
- Cross-site visibility: `manager` can see only their site; `admin` sees both

**Acceptance:** Bill (admin) can log in and access both sites. Rick (manager, Eugene) can log in and access Eugene only. Attempts to access Woodland from Rick's session return 403.

### [x] T-004: PIN flow for operator iPad

- `/operator` route lands on a name-picker (lists active operators at the site, ordered by last-seen-recent)
- Tapping a name reveals the 4-digit numeric keypad
- PIN validates server-side (Argon2id), with rate limit: 5 failures in 60 seconds → 15-minute auto-unlock lockout
- Pattern disallow at PIN-set time: sequential, all-same, repeated-pair
- PIN reset by manager (own site) or admin (any site), audit-logged
- Auto-logout: after every load submission, after 5 minutes idle, on explicit "Switch user"

**Acceptance:** Test operator with PIN `4738` can log in, perform a no-op session, logout. Lockout triggers correctly. Reset flow audit-logged.

## Core operator path (the dock workflow)

### [x] T-005: Expected-loads queue

- Operator lands on the queue post-login: list of pre-scheduled inbound loads for their site, sorted by expected arrival time
- Each row: source, expected time, transporter, BOL number
- Pull-to-refresh, auto-refresh every 60 seconds
- Empty state: "No loads expected today" with last-sync timestamp

**Acceptance:** Seeded test loads appear correctly. Empty state renders cleanly. Pull-to-refresh works on iPad Safari.

### [x] T-006: Load workflow — BOL → weight → door-open → stack → finish/reject

Implement the seven-stage flow from charter §4 in order:

1. Forced BOL photo (timer does not start)
2. Optional weight ticket — two equal-weight buttons (Add / None), if added: photo + integer-pounds numeric pad (1–100,000 valid range)
3. Forced door-open photo — **timer starts on submission of this photo**
4. Decision branch: Begin unload / Reject load
   5a. Unload: stack counter UI with three modes (ledger, multiplier, total) — see charter §4.3
   5b. Reject: category dropdown + multi-photo + note + submit
5. Finish (timer stops) → optional concern capture (multi-photo, in-app annotation, voice-to-text note in operator's locale)
6. Submit (auto-logout)

**Acceptance:** Full happy-path completes end-to-end. Forced photos cannot be skipped. Rejection persists with status terminal. Submit creates correct row in `inbound_loads` and rows in `load_stacks`, `load_photos`, `load_concerns`.

### [x] T-007: Photo capture, annotation, R2 upload

- Native iPad Camera invocation via `<input type="file" capture="environment" accept="image/*">`
- In-browser annotation tool (circle, arrow, freehand, text overlay)
- Both raw and annotated versions uploaded to R2 with signed URLs
- Photo metadata: `kind` enum (bol, weight_ticket, door_open, concern, rejection), `storage_key`, `annotation_storage_key` (nullable)
- Server-side R2 upload (iPad does not authenticate to R2 directly)

**Acceptance:** Photos persist. Annotation overlay survives reload. R2 URLs return 200 when accessed with a fresh signed URL.

### [x] T-008: i18n — English, Spanish, Urdu

- All operator-facing copy localized
- Locale picker on the login screen, persisted per-user
- Urdu flips RTL globally for that user
- Date/time formatting matches locale conventions
- Voice-to-text uses native iPadOS dictation; correctness is iPadOS's job, not ours

**Acceptance:** Switch locale → all visible strings change correctly. Urdu renders RTL. Spanish and English render LTR. No untranslated strings in any operator-facing screen.

### [x] T-009: Offline queue (IndexedDB + Workbox Background Sync)

- All operator submissions queue locally on network failure
- Service Worker registered with explicit cache versioning
- Photos stored as Blobs in IndexedDB until upload completes
- Replay on connectivity recovery; surface unresolved queue items on next login
- Conflict resolution: iPad's queued state wins for own-action, manager-portal reassignment surfaces flagged conflict

**Acceptance:** Disable wifi mid-load. Complete the workflow. Re-enable wifi. Verify all data syncs correctly. Verify photos upload. Verify timer values are preserved (timer ran on the iPad, not the server).

## Manager portal

### [x] T-010: Live dock view

- Per-site real-time view of currently-active operator sessions
- 5-second polling
- Each tile: operator name, load BOL, source, current stage, elapsed time
- Tap a tile → load detail with all photos, stack counts, concerns

**Acceptance:** Two operators on simultaneous loads at Woodland appear as two tiles. Times tick forward in real-time. Tile transitions through stages (BOL → weight → door → stack → finish).

### [x] T-011: Load list with filters

- Per-site list view of today's, this-week's, this-month's, custom-range loads
- Status filter (in-progress, submitted, rejected, submitted-to-mymrc, processed)
- Source filter
- Operator filter
- Transporter filter
- 30-second polling
- Click row → load detail

**Acceptance:** Filters compose correctly. Pagination handles 1000+ loads without UI lag.

### [x] T-012: Compliance dashboard

The seven contract-tracked metrics from `docs/COMPLIANCE.md`:

1. MyMRC submission timeliness (3 business days, ≥95%)
2. Processed-units submission (1 business day, ≥95%)
3. Dock-appointment SLA (60 minutes, ≥90%)
4. Recycling rate (CA 75%, OR 70%)
5. In/out weight reconciliation (≥97%)
6. Storage inventory vs site limit
7. Records retention status

Color-coded tiles (green/yellow/red), with click-through to the underlying data. In-app signals only — no ntfy push.

**Acceptance:** Each tile renders correctly with seeded data. Threshold colors transition correctly. Click-through filters the load list to the relevant subset.

### [x] T-013: MRC Monthly Invoice export + SVdP Internal CSV export

- `MRC Monthly Invoice (Article 10.4)` export: CSV matching MyMRC reconciliation format
- `Transportation Invoice` export: CSV per CA contract
- `Oregon Collection Site Count Invoice` export: CSV per OR contract (V2.2 — placeholder route only)
- `SVdP Internal CSV` export: format TBD pending Bill's conversation with CFO Glenn DePrater
- `Custom Date Range` export: arbitrary date filter

All exports are per-site by default. Cross-site export requires `admin` role and explicit confirmation.

**Acceptance:** Test month's data exports correctly. Reconciliation CSV matches MyMRC's expected schema (see `docs/MYMRC-INTEGRATION.md`).

### [x] T-014: Audit log viewer

- For any record (load, user, source, transporter, etc.), `admin` role can view the full audit trail
- Append-only display: actor, action, timestamp, before/after JSON
- Filterable by actor, table, date range
- No edit/delete UI ever

**Acceptance:** Every mutation in the test session has a corresponding audit row. UI renders the JSON readably.

## MyMRC integration

### [x] T-015: Playwright MyMRC schedule scrape (read-only, hourly)

See `docs/MYMRC-INTEGRATION.md` for full runbook.

- Two separate Playwright contexts (one per site, separate credentials in env)
- Hourly cron pulls next 7 days of scheduled hauls per site
- Upserts into `expected_loads` table
- Reports failures via ntfy `dr3-vision-system` topic to Bill

**Acceptance:** Scheduled hauls appear in the operator's expected-loads queue within 1 hour of being scheduled in MyMRC. Stale entries (haul cancelled in MyMRC) are removed.

### [x] T-016: CSV reconciliation upload (manual, monthly)

- Manager-portal page: upload a monthly MyMRC CSV
- Match each haul row against DR3-Vision loads by (haul_id, date, source)
- Display discrepancies: missing in DR3-Vision, missing in MyMRC, count mismatch, weight mismatch beyond tolerance
- Allow per-row resolution: confirm DR3-Vision is correct, confirm MyMRC is correct, mark for follow-up
- Persist resolution decisions in `mymrc_reconciliation_items`

**Acceptance:** Upload Woodland's last monthly CSV → 95%+ rows reconcile cleanly, remainder flagged with actionable diagnostics.

## Operations & deployment

### [x] T-017: Docker + fleet integration

- Dockerfile builds a production image (multi-stage, ~300MB target)
- docker-compose.yml supports local dev (app + Postgres + minio for R2 emulation)
- Joins SVDP-Guardian, SVDP-Intranet, SVDP-Site networks per FLEET-PRIMER conventions
- Healthcheck endpoint at `/healthz`
- Cloudflare tunnel hostname mapping documented

**Acceptance:** `docker compose build && docker compose up` runs the full stack locally. Production deploy via swarmpilot_deployer is documented in `docs/FLEET-DEPLOYMENT.md`.

### [ ] T-018: Observability

- GlitchTip integration (errors)
- Loki integration (logs)
- Tempo integration (traces)
- Grafana dashboards for: request rate, error rate, MyMRC scrape success rate, R2 upload success rate, offline-queue depth per active session

**Acceptance:** Forced error in dev shows up in GlitchTip within 30 seconds. Grafana dashboard renders with at least 5 minutes of seeded traffic data.

### [x] T-019: Initial production deploy to dr3-vision.svdp.us

- Cloudflare DNS + Tunnel configured
- TLS via CF
- HSTS, CSP, X-Frame-Options, X-Content-Type-Options headers
- Production database provisioned, seeded
- swarmpilot_deployer wired to the `main` branch

**Acceptance:** `https://dr3-vision.svdp.us/healthz` returns 200. The brand-correct placeholder page renders. Audit log captures the deploy.

## Sprint-1-complete acceptance

When all 19 tickets are `[x]`:

- Schedule a 30-minute walkthrough with Bill, Rick, Janette, Morena, Kelsey
- Demo: full operator happy-path end-to-end at one site, then the same at the second site
- Demo: manager dashboard, compliance tiles, exports, audit log
- Demo: MyMRC schedule populating the queue
- Demo: offline-queue ride-out (turn off wifi mid-load)
- Demo: ntfy fires to Bill on simulated outage; does NOT fire on operational events

If all five demos pass without interruption, Sprint 1 is shipped.

---

## Backlog — V2.1 and beyond (do not start in Sprint 1)

- ADR-0011 — Processor Form deconstruction-line workflow with bonus calculation
- MyMRC write-path (push hauls into MyMRC) — blocked on API access response from MRC
- "Next up" cast view for warehouse TV
- Outbound load tracking — V2.2
- CIP data capture — V2.2
- **Bulk data upload** (operator requirement, captured 2026-05-07). Current import paths cover seed-time CSV (sites/users/holidays/sources/transporters), per-row admin adds via `/admin/users`, operator iPad capture, and the MyMRC hourly scrape + monthly CSV reconciliation. None of these cover one-shot bulk imports — historical inbound-load backfills, bulk source onboarding after a contract change, V1-PHP migration. Specific axis to scope with Bill before designing (likely historical-loads first). New ADR slot expected since the schema implications (audit log entries for historical data, photo placeholders for missing assets, status enum mapping) are non-obvious.
- T-018 observability (the only Sprint-1 ticket not shipped) — GlitchTip + Loki + Tempo + Grafana dashboards for request rate / error rate / MyMRC scrape success / R2 upload success / offline-queue depth. Out of scope until Phase-2 themes are picked.
- Photo annotation canvas re-tackle (descoped from PR #7; offline-queue payload schema needs a backwards-compatible migration to carry annotated PNG alongside raw, deserves its own ticket + ADR).
- ES + UR native-speaker translation review across operator and manager namespaces (auto-translated strings shipped, tagged for review in `_meta` blocks of locale JSON).
- Sacramento site provisioning (when consolidation completes)
