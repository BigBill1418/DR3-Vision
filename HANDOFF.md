> **CURRENT STATE (2026-08-10):** Inbound ingestion was re-keyed off a scheduling field onto the true delivery date (**ADR-0089**) and the Woodland floor recovered from **−1,671 to +1,382**; the July Woodland COR is unblocked at 512 units EOM. The Terex throughput-gap watchdog is **LIVE at Woodland** (ADR-0088). The floor gained haul numbers, load **void** and **back-navigation** (ADR-0090 A/B/C). AP Approvals (ADR-0046) has been live at both sites since 2026-07-15; bonus (bi-weekly, both sites), billing verification, board-pack digest and observability all live earlier. **The single live register of everything hanging is `docs/OPEN-ITEMS.md`** — read it first. Full ship log: `CHANGELOG.md`.
>
> ⚠ **The body of this file below is the ORIGINAL Sprint-1 bootstrap runbook and is historical.** It describes a repo with "decisions, documentation, and scaffolding — but not application code" and lists ADRs through 0011. That was true in May 2026. The application has been in production since then, and there are now **95 ADRs (0001–0090)**. Read the body for how the project was set up, never for what exists today — `README.md`, `CHANGELOG.md` and `docs/adr/README.md` are current.
> Prior state — Operational Intelligence survey (ADR-0034, closed + exported 2026-07-09): `docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md`. Incident resolution + P0 hardening (ADR-0033): `docs/handoffs/2026-06-23-current-state-and-buildout-readiness.md`.

# HANDOFF.md — Claude Code bootstrapping runbook

This file documents how to start Sprint 1 from a clean clone. It is the second file Claude Code reads after `CLAUDE.md`.

## What's in this repo at handoff

The handoff package contains decisions, documentation, and scaffolding — but not application code. Sprint 1 is to write the application code, guided by these documents:

```
dr3-vision/
├── CLAUDE.md                          # Read first
├── HANDOFF.md                         # This file
├── README.md                          # Repo entry for humans
├── PROJECT-CHARTER.md                 # Master spec, ~850 lines
├── .env.example                       # Every env var documented
├── .gitignore
├── package.json                       # Locked dependencies
├── tsconfig.json
├── next.config.js                     # PWA config included
├── tailwind.config.ts                 # DR3 brand tokens
├── Dockerfile                         # Fleet-aware
├── docker-compose.yml                 # Production stack (CHAD-HQ): app + cloudflared
├── docker-compose.dev.yml             # Local dev: postgres + minio + optional containerized app
│
├── docs/
│   ├── SPRINT-1-PLAN.md               # Tickets to execute
│   ├── MYMRC-INTEGRATION.md           # Playwright runbook
│   ├── MRC-CONTRACTS.md               # Both contracts in one place
│   ├── COMPLIANCE.md                  # Dashboard scope, what fires when
│   ├── FLEET-DEPLOYMENT.md            # Deploy runbook
│   ├── QUESTIONS.md                   # File you append to (starts empty)
│   └── adr/
│       ├── README.md                  # ADR index
│       ├── 0001-tech-stack.md
│       ├── 0002-fleet-host.md
│       ├── 0003-domain-routing.md
│       ├── 0004-pin-auth.md
│       ├── 0005-photo-storage.md
│       ├── 0006-offline-queue.md
│       ├── 0007-audit-log.md
│       ├── 0008-brand-theme.md
│       ├── 0009-mymrc-playwright.md
│       ├── 0010-cip-data-handling.md
│       └── 0011-processor-form.md
│
├── prisma/
│   ├── schema.prisma                  # First-draft DDL
│   └── seed/
│       ├── README.md
│       ├── sites.csv
│       ├── users.csv
│       ├── site_holidays.csv
│       ├── processor_bonus_rules.csv
│       ├── sources.csv                # 105 real Woodland + 6 Eugene placeholders
│       └── transporters.csv           # 11 real entries
│
└── legacy/
    └── README.md                      # V1 PHP archive note
```

## What's missing — your job in Sprint 1

The application code itself: `src/`, `tests/`, `public/brand/`, the actual Prisma seed script, the Playwright harness, the React components, the API routes. See `docs/SPRINT-1-PLAN.md` for the prioritized backlog.

## First-session bootstrap sequence

When you open this repo for the first time, execute in order:

### Step 1 — Read

```
CLAUDE.md
PROJECT-CHARTER.md
docs/SPRINT-1-PLAN.md
docs/adr/0001-tech-stack.md through 0011-processor-form.md
docs/MRC-CONTRACTS.md
docs/COMPLIANCE.md
prisma/schema.prisma
```

This is roughly 4,000 lines total. Read all of it. The charter cross-references ADR numbers; following the cross-references is more efficient than reading top-to-bottom.

### Step 2 — Verify environment

```bash
node --version    # Expect 20.x or 22.x
npm --version     # Expect 10.x+
docker --version  # Expect 24+
```

If any are wrong, stop and write a `docs/QUESTIONS.md` entry. Do not silently change versions.

### Step 3 — Install + database up

```bash
npm install
docker compose -f docker-compose.dev.yml up -d postgres
npx prisma migrate dev --name init
npx prisma db seed
```

Expected outcome: a Postgres instance running on `localhost:5432` with all tables created and seed data loaded. `npx prisma studio` should show:

- 2 rows in `sites` (eugene, woodland)
- 6 rows in `site_holidays` × 2 sites = 12 rows
- 2 rows in `processor_bonus_rules` (one per site)
- ~111 rows in `sources` (105 Woodland + 6 Eugene placeholders)
- 11 rows in `transporters`
- 5 rows in `users` (Bill, Kelsey, Morena, Rick, Janette)

### Step 4 — Smoke test the dev server

```bash
npm run dev
```

Open `http://localhost:3000`. You should see a "DR3-Vision — coming soon" placeholder served from the App Router with the brand palette applied. If the page loads with the wrong colors (red, blue, etc.), stop — `tailwind.config.ts` was not loaded properly. The brand palette is non-negotiable.

### Step 5 — Pick the first ticket

Open `docs/SPRINT-1-PLAN.md`. Tickets are ordered by dependency. Take the first unblocked one. Acceptance criteria are explicit. When complete, mark it done in the file (preserve the original ordering; do not reorder), commit, and move to the next.

## Definition of "Sprint 1 complete"

Sprint 1 is done when an operator with a 4-digit PIN can:

1. Log into the iPad PWA at `http://localhost:3000` (or `dr3-vision.svdp.us` once deployed)
2. See the expected-loads queue for their site
3. Tap a load, capture a BOL photo, optionally capture a weight ticket
4. Capture a door-open photo (timer starts on this photo's submission)
5. Enter stack counts in any of three modes (ledger, multiplier, total)
6. Optionally raise concerns with category, photo, annotation, and voice note
7. Finish the unload (timer stops) or reject the load with category + photo + note
8. Submit, with all data persisted to Postgres and photos pushed to R2

A manager can:

1. Log into the browser portal with email + password
2. See the live dock view (5-second polling) with the active operator session highlighted
3. See today's load list, with status, operator, and counts
4. See the Compliance dashboard with the seven contract-tracked metrics
5. Reassign a load between operators (exception flow only)
6. Generate the MRC Monthly Invoice export and the SVdP Internal CSV export
7. View the audit log for any load

The MyMRC integration runs hourly via Playwright (per ADR-0009), pulling the next 7 days of scheduled hauls into the loads queue and reconciling completed loads against MyMRC haul records.

The compliance dashboard surfaces the seven metrics from `docs/COMPLIANCE.md`. ntfy fires to Bill on system/container events only, never operational events.

## What is explicitly NOT in Sprint 1

- The V2.1 Processor Form deconstruction-line workflow (see ADR-0011) — backlog
- The MyMRC write-path (push hauls into MyMRC from DR3-Vision) — V2.1, blocked on API access
- Outbound load tracking — V2.2
- Consumer Incentive Program (CIP) data capture — V2.2 (see ADR-0010)
- The "Next up" cast view for a TV in the warehouse — V2.1 backlog
- A "Recover from paper" flow — explicitly rejected (see Q20 in charter changelog)
- Any Stockton-related code, copy, or seed data — explicitly excluded

## Definition of done for the handoff itself

This handoff package is "done" when:

- A new Claude Code session opens the repo, reads `CLAUDE.md`, follows the bootstrap sequence above, and reaches Step 4 (working dev server with brand palette) within one hour of session start.
- That same session can pick up the first ticket from `docs/SPRINT-1-PLAN.md` and begin work without asking Bill for clarification.

If that's not true, this file is incomplete — file a `docs/QUESTIONS.md` entry describing what's missing.
