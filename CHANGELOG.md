# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

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
