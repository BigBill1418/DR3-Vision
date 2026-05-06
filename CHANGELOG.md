# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### 2026-05-06 — Canonical logo + compose restructure (incident recovery)

Two things in one ship because they couldn't safely be split.

**Canonical logo wired in.** Bill provided the canonical DR3-Vision
logo (`public/brand/dr3-vision-logo.jpg`, 1168×784) — eye-as-"o"
treatment in cyan on a dark space backdrop. Closes ADR-0012 §5 and
HANDOFF open decision #1. The placeholder page now shows the logo
image as the hero with "— coming soon" beneath, on a black background
that matches the logo's backdrop. Background change is scoped to the
placeholder route only; layout-level body bg stays on `--dr3-green-deep`
per ADR-0008. The earlier inline-SVG eyeball + text wordmark are
removed. Footer caption under the SVdP seal swapped to a `svdp.us`
hyperlink at Bill's request.

**Compose restructure.** Production compose moved from
`deploy/docker-compose.yml` to root `docker-compose.yml`; the previous
root dev compose moved to `docker-compose.dev.yml`. Driver was a deploy
incident: the noc swarmpilot deployer's remote-deploy code path
(compose stacks on non-HQ hosts) does NOT honor the `compose_file:`
config knob — only the local-deploy path does. So when the deployer
ran `docker compose up -d` on CHAD-HQ after the prior push it hit the
DEV compose at root, started the dev MinIO container, and tore down
`dr3-vision-cloudflared` as an "orphan" — knocking the tunnel down and
returning HTTP 530. Recovery: manual `docker compose down --remove-orphans`

- rebuild + up against the prod compose. Permanent fix: this
  restructure, plus updated comments at the top of `docker-compose.yml`
  explaining why it MUST be the production file. README.md and HANDOFF.md
  updated to invoke the dev compose explicitly with `-f docker-compose.dev.yml`.
  ADR-0013 §1 already records the structural choice.

### 2026-05-06 — T-001 follow-up: deployable to CHAD-HQ

Lands the production deploy surface for the T-001 placeholder.

- New `/healthz` route at `src/app/healthz/route.ts`. Returns
  `{ ok, version, uptime_s }` with HTTP 200. Hit by the Dockerfile
  HEALTHCHECK, the swarmpilot post-deploy smoke probe, and the
  per-tunnel CF Healthcheck. The response shape grows toward the
  contract in `docs/FLEET-DEPLOYMENT.md` §"Healthcheck" as T-002 / T-007
  bring DB + R2 online.
- New `deploy/docker-compose.yml` — production stack: `app` (Next.js
  standalone) + `cloudflared` sidecar bound to the dedicated
  `dr3-vision` tunnel (UUID `3999bb3b-7f86-4896-8f8c-77ef27f8f2cf`).
  Per ADR-0008 (svdp-intranet), each service gets its own tunnel and
  the cloudflared sidecar lives inside the compose so rollback is
  atomic with the app rollback. Compose is invoked with
  `--project-directory ..` so the build context resolves to the repo
  root. Cloudflared image pinned to `2026.3.0` (fleet standard from
  the eyeson-managed pin).
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
