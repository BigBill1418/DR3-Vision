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
- All data feeds the MRC Monthly Invoice (~$7M annual revenue), the Compliance dashboard (recycling rate, processing deadlines, dock SLAs), and the audit trail required by both Oregon DEQ and California CalRecycle.

## Who it's for

- **Forklift operators and warehouse staff** — primary users, English/Spanish/Urdu speakers, gloves on, clipboards out
- **Site managers** — Rick Albritton (Eugene), Janette Thomas (Woodland)
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
- **Tests:** full `vitest` suite green (698); `tsc --noEmit` exits 0; ESLint clean.
- Pending operator action: drop `~/.dr3-vision-secrets/mymrc.env` on CHAD-HQ to flip the hourly MyMRC scrape on (per `docs/operator/mymrc-setup.md`); upload a real monthly MyMRC CSV through `/dashboard/<site>/reconciliation` to validate the 95% clean-match acceptance.

See `CHANGELOG.md` for the full ship log; see `docs/SPRINT-1-PLAN.md` / `docs/SPRINT-2-PLAN.md` for ticket-by-ticket state and the ADRs (`docs/adr/`, through 0023) for locked decisions.

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
