# CLAUDE.md — instructions for Claude Code working in DR3-Vision

You are working on **DR3-Vision**, a 100% browser-based PWA that replaces paper-based mattress recycling tracking at DR3 facilities. DR3 is a wholly owned subsidiary of St. Vincent de Paul Society of Lane County (SVdP), and all DR3 profits fund SVdP human services.

**This file is your primary orientation. Read it on every new task in this repo.**

## Read-order on first session

1. **`PROJECT-CHARTER.md`** — the master spec, ~850 lines. Authoritative for every product question. When you're unsure what to build, the charter has the answer.
2. **`HANDOFF.md`** — the bootstrapping runbook for Sprint 1.
3. **`docs/SPRINT-1-PLAN.md`** — the actual task list with acceptance criteria.
4. **`docs/adr/`** — read all ADRs (81 files as of 2026-08-05: 0001–0076 plus 0019.1/0019.2 and a few split/duplicate numbers; see `docs/adr/README.md` for the index). They are short. They lock in technical decisions you should not re-litigate. ADR-0012 in particular bundles seven Sprint-1 clarifications that supplement ADRs 0001/0004/0008/0009; the bonus system spans ADR-0019/0019.1/0019.2/0020/0021/0022/0023/0025 (0025 hardens the ADR-0019.1 escalation tier-4 alert).
5. **`prisma/schema.prisma`** — the data model, draft form. Iterate on it during Sprint 1 but preserve the field semantics and table relationships.

## Hard rules — do not violate

1. **Never mention "Stockton" anywhere in user-facing code, docs, UI strings, or seed data.** Stockton is part of the company's consolidation exit; it is excluded from V2 entirely. Eugene and Woodland are the two operating sites.
2. **Eugene and Woodland are strictly separated.** Different MRC contracts, different jurisdictions (Oregon vs California), different rates, different storage limits, different retention rules. Every query, list, export, alert is scoped to one site by default. Cross-site **reach** requires `admin` role **or** a manager with the `all_sites` flag (ADR-0024). Admin **powers** (user management, bonus amendment/override, `/admin/*`) remain `admin`-only — never grant those off `all_sites`. The check for _site reach_ is `role === 'admin' || all_sites`; the check for _admin powers_ stays `role === 'admin'`. Do not reconflate them.
3. **The DR3 brand colors are GREEN (#00524C primary) and BLACK.** Not red, not navy, not gold. The "D" in DR3 is green; "R3" is black. Use `--dr3-green-deep`, `--dr3-green` (most-used secondary), `--dr3-chartreuse`, `--dr3-cream`, `--dr3-ink` from `tailwind.config.ts`. The SVdP red palette belongs to the parent organization, not DR3.
4. **All user-facing copy supports English, Spanish, and Urdu (RTL) on day 1.** Internationalization is not a "later" thing — it ships with MVP.
5. **ntfy push notifications go to Bill Barnard ONLY** and only for system-level events (`dr3-vision-system`, `dr3-vision-container` topics). Operational events (rejections, long unloads, SLA breaches, PIN lockouts) are in-app dashboard signals, never push. See `docs/COMPLIANCE.md`.
6. **Audit log is append-only and retained indefinitely.** Never write code that deletes or updates audit rows. The audit table grows; do not "clean it up."
7. **Photos go to Cloudflare R2 via signed URLs; never store them in the application database or on the fleet host's local disk.**
8. **PINs are 4 digits, hashed with Argon2id, never logged.** The `pin_hash` column is not indexed. PIN lookup is by `user_id` from a name-picker UI, then PIN comparison — never a `WHERE pin_hash = ?` query (that would enable PIN enumeration).
9. **No browser storage APIs in the PWA shell other than IndexedDB and the Service Worker cache.** No `localStorage`, no `sessionStorage`. The offline queue is the only persistence path on the iPad.
10. **Forms in React must use `onClick` handlers, not HTML `<form>` elements.** This is a fleet-wide convention.
11. **The canonical DR3-Vision brand mark is `public/brand/dr3-vision-logo.jpg`** (per ADR-0014). Use it on every surface that shows a brand mark — placeholder, login (T-003), splash, app-shell brand strip, marketing, PDF headers. Auth surfaces (placeholder + `/login`) use a black background to match the mark's space backdrop; operator + manager working surfaces stay on `--dr3-green-deep` per ADR-0008. The cyan accent in the logo is asset-internal and does not become a `tailwind.config.ts` token.

12. **Staff-facing output ships PILOT (ADR-0047 rollout gate).** Any change that adds or expands staff-visible output — email/ntfy notifications, new recipient rosters, new dashboards or UI surfaces linked from emails — ships in `pilot` and is ramped only by Bill from `/admin/rollout`. Feature code MUST NOT import the raw mail sender (`@/lib/m365-mail`) — route staff mail through `notifyStaff()`, which resolves the `(surface_code, site)` rollout state (pilot ⇒ admins-only with a would-have-sent header; live ⇒ real recipients). Register every new staff-facing surface with a `rollout_surfaces` row (born pilot). The repo test `src/lib/notify/__tests__/no-direct-mail.test.ts` enforces the chokepoint; the allowlist is the transport core, the notify layer, auth, the payroll delivery path, and the grandfathered signature-chain + survey + daily-report + amendment senders. Recipient rosters named in directives/handoffs are the EVENTUAL audience, never day-one.

## What "done" looks like

A feature is done when:

- The acceptance criteria in `docs/SPRINT-1-PLAN.md` for that ticket are met.
- Tests pass: `npm test` and `npx playwright test` both green.
- TypeScript compiles with zero errors and zero warnings.
- ESLint passes with zero warnings (warnings are errors in this project).
- Manual verification: a fresh `docker-compose up` followed by `npx prisma db seed` reaches a usable state.
- An ADR is written if the work involved a non-obvious technical decision.

## Where to ask questions

This project does not have a synchronous human reviewer for every decision. When you encounter a question the charter and ADRs don't resolve:

1. First, search the charter for the topic. It is comprehensive.
2. If the charter is silent, write a `docs/QUESTIONS.md` entry with your question, your proposed answer, the alternatives you considered, and proceed with your proposed answer flagged as `// TODO(question-N): see docs/QUESTIONS.md`. Bill (the project director) reviews this file out-of-band.
3. Never silently make a product decision and bury it in code.

## What this project is not

- It is not a green-field experiment. It replaces a paper process that operates under regulated MRC contracts with real money at stake. Every load tracked, every photo, every weight feeds billing and compliance.
- It is not a multi-tenant SaaS. Two sites, fixed. New sites are a data migration, not a tenancy provisioning flow.
- It is not a real-time collaborative editor. The portal polls; live-streaming updates are V2.1+.
- It is not an AI product. There are no LLM calls in the operator or manager flows. (Ops tooling and analytics may use models, but never in the critical-path workflow.)

## Build context

- **Repo:** `BigBill1418/DR3-Vision` on GitHub
- **Service code:** `dr3-vision`
- **Public domain:** `dr3-vision.svdp.us`
- **Fleet host:** CHAD-HQ (10.99.0.2 / `svdp-dev`). Co-tenant stacks on the same host today: SVDP-Guardian, SVDP-Intranet, Helix-Hub, CallVault, DroneOpsMap, LodeStar, VLM analytics. (SVDP-Site is **not** on CHAD-HQ — it migrated to BOS-HQ 2026-04-20.) DR3-Vision joins only its own compose bridge network `dr3-vision_dr3net`; there is no `SVDP-Guardian` / `SVDP-Intranet` / `SVDP-Site` shared docker network — verified `docker network ls` on CHAD-HQ 2026-08-03.
- **Deployment:** Docker container, swarmpilot_deployer auto-deploys from `main`
- **Stack:** Next.js 15 App Router + TypeScript, Postgres 16 + Prisma, Auth.js v5, Tailwind + shadcn/ui, R2 storage, Playwright for MyMRC scraping
- **V1 archive:** `legacy/` — V1 PHP code, do not touch, retained for reference only

Loose ends live in **`docs/OPEN-ITEMS.md`** (the single hanging-items register:
operator actions, stakeholder blocks, accepted residuals). Finish work with a
loose end → append it there; close one → mark it Done there.

When in doubt: read the charter, read the ADRs, then act.

## Verify before you advocate (fleet-wide, ADR-0181)

A capable model is not a correct one — fluency and confidence are not evidence.
The default posture on every non-trivial call is **check, then act**, never _act,
then hope_.

1. **Primary source over memory.** Read the actual file, run the actual query,
   hit the actual API, `docker exec` the actual container. Memories, prior
   sessions, ADRs and inherited copy are point-in-time claims — stale until
   re-verified. Docs describe intent; the running system is truth.
2. **Best-practice path, not merely one that runs.** If the approach is
   non-obvious, research it — upstream docs, existing fleet precedent and ADRs,
   the tool's own help — before committing to it. "It works" is not the bar.
3. **State the reasoning, not just the conclusion.** If the logic doesn't
   survive being written down, it wasn't sound.
4. **Verify the observable end state after acting.** Not the exit code: the
   version actually live, the row actually present, the alert actually
   delivered, the suite green with its output quoted.
5. **Say when uncertain.** "I believe X but haven't confirmed Y" beats false
   confidence. State assumptions at the point you make them.

**Red flags — each means stop and verify:** "this should work", "it's probably
still configured that way", "I remember this file does X", "the docs say so",
"that's how it usually works"; reaching for a fix before reading the code;
feeling certain about a system you haven't actually looked at this session.

**Not a licence for paralysis**, for producing a runbook instead of doing the
work, or for asking a question that reading a file would answer. Verify, then
execute — the check is a step inside the work, not a substitute for it.

Full reasoning, prior art (ADR-0178, ADR-0180) and alternatives considered:
`noc-master/docs/adr/0181-verify-before-advocating.md`. Also carried in the
operator's global `~/.claude/CLAUDE.md`; this copy travels with the repo.
