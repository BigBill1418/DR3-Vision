# DR3-Vision

**A 100% browser-based PWA replacing paper-based mattress recycling tracking at DR3 facilities.**

DR3 ("Divert, Reduce, Reuse, Recycle") is a wholly owned subsidiary of [St. Vincent de Paul Society of Lane County (SVdP)](https://www.svdp.us). All DR3 profits fund SVdP human services for homeless and housing-unstable individuals and families in Lane County, Oregon. Founded in 1999 in Oakland, California, DR3 was the first commercially viable mattress recycling business in the world. SVdP is now the nation's oldest and largest mattress recycler.

DR3-Vision tracks every inbound mattress load at DR3's two operating facilities — Eugene, Oregon and Woodland, California — replacing a paper-based intake process that operates under regulated stewardship contracts with the [Mattress Recycling Council (MRC)](https://mattressrecyclingcouncil.org).

## What it does

- Forklift-mounted iPads at the dock capture every load: BOL photo, weight ticket, door-open photo, stack counts, concerns, rejections — all timestamped, all signed, all persisted offline-tolerant.
- A browser portal lets facility managers monitor live dock activity, manage exceptions, run compliance dashboards against MRC contract requirements, and generate billing-ready exports.
- An hourly Playwright job pulls scheduled hauls from MyMRC, MRC's vendor portal, and reconciles completed loads back against MyMRC haul records.
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
- **Auth.js v5** (PIN flow on iPad, email/password for portal)
- **next-pwa** + IndexedDB + Workbox Background Sync (offline-tolerant)
- **Cloudflare R2** (photo storage)
- **Playwright** (MyMRC integration)
- **Docker** + swarmpilot_deployer (fleet deployment to CHAD-HQ)
- **GlitchTip + Loki + Tempo + Grafana** (observability)

## Status

**Pre-Sprint 1.** This repo contains the project charter, architecture decisions, integration documentation, schema draft, and seed data. No application code has been written yet.

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
