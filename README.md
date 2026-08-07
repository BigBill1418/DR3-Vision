# DR3-Vision

**A 100% browser-based PWA replacing paper-based mattress recycling tracking at DR3 facilities.**

DR3 ("Divert, Reduce, Reuse, Recycle") is a wholly owned subsidiary of [St. Vincent de Paul Society of Lane County (SVdP)](https://www.svdp.us). All DR3 profits fund SVdP human services for homeless and housing-unstable individuals and families in Lane County, Oregon. Founded in 1999 in Oakland, California, DR3 was the first commercially viable mattress recycling business in the world. SVdP is now the nation's oldest and largest mattress recycler.

DR3-Vision tracks every inbound mattress load at DR3's two operating facilities — Eugene, Oregon and Woodland, California — replacing a paper-based intake process that operates under regulated stewardship contracts with the [Mattress Recycling Council (MRC)](https://mattressrecyclingcouncil.org).

## What it does

- Forklift-mounted iPads at the dock capture every load: BOL photo, weight ticket, door-open photo, stack counts, concerns, rejections — all timestamped, all signed, all persisted offline-tolerant.
- A browser portal lets facility managers monitor live dock activity, manage exceptions, run compliance dashboards against MRC contract requirements, and generate billing-ready exports.
- An hourly Playwright job pulls scheduled hauls from MyMRC, MRC's vendor portal, and reconciles completed loads back against MyMRC haul records.
- The **Bonus Management System** runs the processor bonus end to end for **both Woodland and Eugene** — daily per-employee entry, a code-enforced **bi-weekly** pay-period state machine (26 periods/year, Tue→Mon, Friday pay date), dual sign-off (facility + ops signer) with an asymmetric override path and a Tuesday 08:30 PT auto-override that guarantees the 09:00 PT payroll deadline, auto-generated co-branded PDF, direct delivery to SVdP payroll via Microsoft Graph, plus amendment, full history, and per-employee/annual aggregates with CSV export. Cadence is bi-weekly (not monthly) and Eugene is enabled per the Sprint-2 addendum (ADR-0019.1 + ADR-0019.2; cutover runbook at `docs/operator/bonus-cadence-and-eugene-cutover.md`).
- A role-aware **Vision Dashboard** is the authenticated landing page — a branded tile launcher that surfaces each user's available capabilities and the V2.1+ roadmap as Coming Soon tiles.
- The **AP Approvals module** (ADR-0046, LIVE at both sites since 2026-07-15) turns a shared mailbox (`approvals-dr3@svdp.us`) into a vendor-invoice approval queue: staff forward an invoice, the roster of approvers is alerted, the first decision wins (approve/reject with a required Woodland/Eugene site tag and a note that rides the output), and accounting gets back the ORIGINAL invoice stamped on every page (decision + approver + site + note + Pacific time), archived to R2 with a dual-sha tamper record.
- All data feeds the MRC Monthly Invoice (~$7M annual revenue), the Compliance dashboard (recycling rate, processing deadlines, dock SLAs), and the audit trail required by both Oregon DEQ and California CalRecycle.

## Who it's for

- **Forklift operators and warehouse staff** — primary users, English/Spanish/Urdu speakers, gloves on, clipboards out
- **Site managers** — Rick Albritton (Eugene), Janette Tomas (Woodland)
- **DR3 Operations Manager** — Morena Gomez, both sites
- **DR3 Data & Compliance lead** — Kelsey Ruhland, MRC contract SME
- **Director of Operations, SVdP** — Bill Barnard, project sponsor

## Stack

- **Next.js 15** (App Router) + TypeScript + Tailwind + shadcn/ui
- **Postgres 16** + Prisma
- **Auth.js v5** (PIN flow on iPad, Microsoft Entra ID SSO for managers/admins per ADR-0016)
- **next-pwa** + IndexedDB + Workbox Background Sync (offline-tolerant)
- **Cloudflare R2** (photo storage)
- **Playwright** (MyMRC integration)
- **Docker** + swarmpilot_deployer (fleet deployment to CHAD-HQ)
- **GlitchTip + Loki + Tempo + Grafana** (observability)

## Status

**Live in production at <https://dr3-vision.svdp.us> (CHAD-HQ). Bonus Management System went live for the Period-13 go-live on 2026-06-09.** Sprints 1, 2, and 3 are all shipped.

- **Sprint 1 (2026-05-07).** T-001 through T-016 — foundation, operator iPad workflow, manager portal, compliance dashboard, exports, audit log viewer, MyMRC scrape, reconciliation upload. Post-Sprint-1: Microsoft Entra ID SSO (ADR-0016), `/admin/users` panel (ADR-0017), `/admin/audit` viewer (ADR-0018).
- **Sprint 2 + addendum (2026-06-06).** Bonus Management System (ADR-0019): daily per-employee entry, bi-weekly pay-period state machine (ADR-0019.1 — 26 periods/year, Tue→Mon, Friday pay date, Tuesday 08:30 PT auto-override), dual sign-off, co-branded PDF, payroll delivery via M365 Graph (ADR-0021), Vision Dashboard tile landing (ADR-0020). Eugene enabled as a second bonus site (ADR-0019.2). Production cutover executed 2026-06-06; Period 12 skipped, Period 13 is the first canonical bi-weekly PDF.
- **Sprint 3 (2026-06-08 → 2026-06-09).** Historical bonus data import (ADR-0023) — 17 months (Jan 2025 → Jun 2026) reconciled on the live database to **$113,776.00 to the cent**: 104 pay periods (76 `historical_imported`), 5,158 daily entries, 94 processors, 76/76 historical PDFs in R2. Fleet observability wired in (ADR-0022 — GlitchTip, Loki, Tempo, Grafana, Prometheus, ntfy), closing the T-018 deferral. M365 Mail.Send production-ready. Bonus UX pass (findable Pay Period History + Manage Employees, Pay-Period nomenclature, date-picker hint) and the `init: true` container fix that reaps Playwright/chromium zombies. Five confirmed M365 staff (Kelsey, Morena, Rick, Janette, Patrick) activated to sign straight in through the Entra gate.
- **Go-live day follow-ups (2026-06-09).** All-sites manager flag for Kelsey (ADR-0024 — both-site reach without admin powers). First-use audit: full team adoption (all 6 active users signed in), Period 13 in active use. Two escalation/notification fixes from the go-live audit (ADR-0025): `publishNtfy` now retries each delivery path under a 12 s budget so a transient blip can't drop a payroll page, and the 09:00 PT tier-4 "deadline missed" alert was rescoped to live-lifecycle states only (it had false-fired on the archival `historical_imported` Period 12).
- **Employee-number extraction (2026-06-15, ADR-0026).** A staff member had appended a trailing 4-digit employee number to `BonusEmployee.full_name` (21 of 107 rows, all Woodland). Migration `20260615_bonus_employee_number` relocates those numbers into a dedicated `employee_number` field, strips+trims `full_name`, and preserves the pre-edit name in `previous_names` for provenance. Idempotent; non-matching rows untouched; verified against live prod in a rolled-back transaction (21 extracted, 0 left numbered). No `users.name` change (that table was clean); the parallel question of an `employee_number` on `users` is deferred (QUESTIONS.md Q-2).
- **2026-06-15 follow-ups.** Surfaced `employee_number` end-to-end in the Manage Employees UI (list + create + inline edit, per-site uniqueness, en/es/ur). Added a PWA "update available — tap to reload" prompt so a deploy never strands an open client on a stale shell (ADR-0027; `skipWaiting:false` + waiting-SW pattern). Fixed the daily-entry grid so changing the date repopulates instantly (re-key by date — it had needed a manual reload).
- **Sprint 4 — prior-day amendment workflow + manager date picker + bi-site EOD check (2026-06-16, ADR-0028).** Four-eyes approval gate for prior-day edits within the current `draft` period: a manager's prior-day count change/insert routes to a `bonus_amendment_requests` ledger requiring a counterpart approver and a ≥20-char justification, with a "Ping Bill" soft-control escape that adds the Director as an alternate approver; Bill is notified on every approve **and** reject (ntfy + M365 mail). Closed periods stay immutable (admin escape valve unchanged); no period state-machine changes. The admin-only date picker is replaced by `BonusDatePicker` (all managers; constrained to the current period for managers, unconstrained for admins). Bi-site EOD-check daemon (per-site missing-entry fingerprint) added as a compose service. Migration `20260616_amendment_workflow` is purely additive (new table + 2 enums). Patrick Dills carved out (read-only) per separation of duties.
- **Amendment notification batching + in-app review nav (2026-06-16, ADR-0029).** A manager correcting N prior-day lines in one save now files one **submission group** (`submission_group_id`, nullable TEXT) and is notified **once per root action** instead of once per line — the 16-line-correction = 16-email problem (ADR-0037 "deduplicate against root cause"). The queue offers Approve-all / Reject-all per group (one transaction, one result notification); the per-item modal is replaced by one batch modal. A gated **"Pending Amendments"** nav link (admins + signature-chain signers only) makes the queue reachable in-app, not just via the email link. Migration `20260616_amendment_submission_group` is additive + idempotent. Deployed + verified on prod (legacy pre-migration rows stay null-group singletons by design; live self-test confirmed one-notification-per-batch, fully reverted).
- **AP Approvals module — LIVE in production (2026-07-06 → 2026-07-15, ADR-0046/0047, PRs #92–#107).** Mailbox-driven vendor-invoice approval queue, piloted, operator-validated ("working perfectly"), and flipped live at BOTH sites 2026-07-15. Same-day hardening: site tag REQUIRED on every decision (PR #105), approver note drawn onto the returned invoice PDF (PR #107), dark-space office theme + AP tile + inline attachment preview + GP-key email strip + stamped-original decision mail (PRs #99–#101). Operator runbook: `docs/operator/ap-approvals.md`; live register: `docs/OPEN-ITEMS.md`.
- **Loads & Inventory + MyMRC + Ops Dashboard session (2026-07-22 → 2026-07-23).** A batch of P1/go-live work shipped: **Loads & Inventory LIVE at both sites** (ADR-0037 — the running-balance/commodity/processed-units-close layer flipped from pilot to `live`, plus Phase-3 paper-bootstrap manager surfaces incl. bulk daily inbound `paper_bulk`, and the definitive Rick/Morena non-program classification rule that is the MRC billing basis). **MyMRC full-object ingestion Phase 1** (ADR-0057 — the always-on hourly scrape now runs un-gated on a single admin identity, historical backfill with the SOQL-OFFSET-2000 sort-flip fix, and a batched `getRecordWithFields` detail transport that took billing-field capture from ~0.4% to 100%). **Operations Dashboard tile re-enabled** born-live for the Eugene iPad go-live (ADR-0020 — comprehensive per-site + combined-site overview). **AP Approvals Amendment 5/6** (ADR-0046 — structured four-field Approve with vetting friction, $1,000 dual-approval, vendor baselines + variance + invoice history, equipment linking, and desktop-only attachment-preview reliability). The count-day boundary was corrected to a Pacific-midnight anchor convention.
- **Terex history import (2026-08-07, ADR-0081).** Nineteen months of the Terex's own daily figures — read off the monthly operating tabs of Janette's `TEREX.xlsx`, measured against the real 490,670-byte R2 artifact — now sit in the machine's own table beside JT's entries: **319 rows, 2025-01-02 → 2026-07-24, zero duplicate dates**, from 24 allowlisted monthly tabs out of 40 sheets. Dates come from **cells**, never row ordinals; tab selection is an explicit 24-name allowlist cross-checked against each tab's own title row, because three decoy tabs (`Aug25(1)`, `Template`, `Template (2)`) carry byte-identical canonical headers. A new `source` column on `equipment_daily_throughput` (not a sibling table) keeps ADR-0079's one-live-figure-per-machine-per-day index in force, and **JT's entry is never overwritten by the sheet** — adjudicated inside the statement by `ON CONFLICT … DO UPDATE … WHERE source = 'workbook_import'`, not by a read-then-write. Reconciliation runs over the row range the workbook's **own SUM formula declares**, which surfaced two real arithmetic defects in the spreadsheet (`March25`, `Dec25`) instead of hiding them behind a ~19% tolerance. Trailing means now blend `entered` with `workbook` and carry their composition ("7-day mean — 5 sheet, 2 entered"), **superseding ADR-0079 Am.1 D10** for that pair; the floor-wide `legacy_derived` series is still never blended.
- **Tests:** full `vitest` suite green; `tsc --noEmit` exits 0; ESLint clean.
- Pending operator action: enter the MyMRC admin login at `/admin/mrc-scrape` (stored AES-256-GCM encrypted in the DB — there is no `mymrc.env` to drop), and provision the `MYMRC_CRED_KEY` encryption key on both the `app` and `mymrc-scrape` containers (per `docs/operator/mymrc-setup.md`), to flip the hourly MyMRC scrape on; upload a real monthly MyMRC CSV through `/dashboard/<site>/reconciliation` to validate the 95% clean-match acceptance.

See `CHANGELOG.md` for the full ship log; see `docs/SPRINT-1-PLAN.md` / `docs/SPRINT-2-PLAN.md` for ticket-by-ticket state and the ADRs (`docs/adr/`, through 0081) for locked decisions.

**For developers:** read [`CLAUDE.md`](./CLAUDE.md) and [`HANDOFF.md`](./HANDOFF.md) to begin.

**For project context:** read [`PROJECT-CHARTER.md`](./PROJECT-CHARTER.md). It is the master spec, ~850 lines, and authoritative for every product question.

## Local development

Requirements: Node 20.x or 22.x, Docker 24+, npm 10+.

```bash
npm install
docker compose -f docker-compose.dev.yml up -d postgres
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
```

Open `http://localhost:3000`.

## Deployment

Production deploys to `dr3-vision.svdp.us` via the BarnardHQ fleet. See [`docs/FLEET-DEPLOYMENT.md`](./docs/FLEET-DEPLOYMENT.md).

## Repository

Public repo: `BigBill1418/DR3-Vision` on GitHub. The previous PHP-based V1 lives in [`legacy/`](./legacy/) for reference and is not deployed.

## License

Internal SVdP project. Not currently licensed for external use. Contact Bill Barnard (`operations@svdp.us`) with questions.

## Contact

- **Bill Barnard** — Director of Operations, SVdP — `operations@svdp.us` — 541-600-7792
- **Kelsey Ruhland** — Data & Compliance — `kelsey.ruhland@svdp.us`
- **Morena Gomez** — DR3 Operations Manager
