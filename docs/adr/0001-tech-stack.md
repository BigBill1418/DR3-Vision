# ADR-0001: Tech stack

**Date:** 2026-05-04
**Status:** Accepted

## Context

DR3-Vision is a 100% browser-based PWA serving forklift-mounted iPads at the dock and a manager portal in the office. It must:
- Work offline-tolerant (warehouse network is good but not infallible)
- Support i18n on day 1 (English, Spanish, Urdu including RTL)
- Integrate with a Salesforce-based vendor portal (MyMRC) and Cloudflare R2 for photos
- Run on a single small Linux host (CHAD-HQ) under Docker, fleet-managed
- Be maintainable by Claude Code with minimal human review

The fleet host is a low-end small-form-factor Linux machine. We are not running a cluster.

## Decision

The stack is:

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 App Router** | Server-side rendering for portal, edge-friendly for fast iPad delivery, file-system routing aligns with Claude Code's strengths |
| Language | **TypeScript** (strict mode) | Type safety across the full stack, especially around the audit-log JSON before/after fields |
| ORM | **Prisma** | First-class TypeScript types, excellent migration tooling, well-documented |
| Database | **Postgres 16** | Single canonical relational store; JSONB for audit-log payloads; mature index ecosystem |
| Auth | **Auth.js v5** (manager/admin) + custom PIN flow (operator) | Auth.js handles session cookies for both; custom PIN flow on top |
| UI | **Tailwind + shadcn/ui** | Component library that ships unbundled (no runtime dependency), composable, theme-friendly |
| PWA | **next-pwa** + Workbox + IndexedDB | Mature offline support; Workbox Background Sync replays queued requests when network returns |
| File storage | **Cloudflare R2** | S3-compatible, no egress fees, integrates cleanly with the existing Cloudflare tunnel |
| Browser automation | **Playwright** | MyMRC scraping; first-class TypeScript support |
| Validation | **Zod** | Shared schemas between client and server; runtime + compile-time guarantees |
| Container | **Docker** + **swarmpilot_deployer** | Fleet convention; auto-deploys from `main` |
| Observability | **GlitchTip** + **Loki** + **Tempo** + **Grafana** | All already running on the fleet, free, self-hosted |

## Alternatives considered

- **Remix instead of Next.js** — Remix has a more elegant data-loading model, but Next.js 15's App Router has caught up enough, and Next.js has stronger PWA tooling and broader ecosystem support.
- **MongoDB instead of Postgres** — relational data fits this domain naturally (loads → photos, loads → stacks, loads → concerns). Audit log relationships are simpler in SQL.
- **AWS S3 instead of R2** — egress fees on S3 are significant when an iPad downloads many photos for an annotation review. R2 has zero egress.
- **Custom auth instead of Auth.js v5** — Auth.js v5 handles enough of the standard flow (sessions, cookies, CSRF) that re-implementing isn't worth it. The PIN flow is a custom addition on top, not a replacement.
- **No PWA, just a website** — operators need offline tolerance and home-screen-app feel; a plain website doesn't deliver that.

## Consequences

- All operator and manager flows render in modern Safari (iPadOS 17+) and modern Chromium. Old browsers are not supported.
- Database migrations are version-controlled via Prisma Migrate. No manual schema changes ever.
- All photos round-trip through the application server (which signs the R2 upload URL), not directly from the iPad to R2. This adds one network hop but eliminates iPad-to-R2 credentialing.
- The fleet host runs Postgres alongside the application container. Backups are the fleet's responsibility (`barnardhq_backup` per FLEET-PRIMER).
- Updates to Next.js, Prisma, and Auth.js require explicit migration ADRs; we do not auto-update major versions.

## References

- Charter §5.1 (Security), §5.2 (Performance), §5.5 (Offline strategy), §6 (Schema), §8 (Tech stack)
- FLEET-PRIMER (in transcripts/uploads), conventions for the BarnardHQ fleet
