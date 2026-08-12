# DR3-Vision production Dockerfile
# Multi-stage: builder → runner
# Target image size: ~300MB (includes Playwright browser binaries)
#
# BUILD CACHING (ADR-0101). Two BuildKit cache mounts below carry the npm
# download cache and the Next.js compiler cache ACROSS builds. Read that ADR
# before touching either `RUN` line — deleting a `--mount` flag silently
# restores the ~14-minute cold compile, and nothing fails to tell you.
#
# No `# syntax=` directive on purpose: CHAD-HQ's built-in BuildKit frontend
# (Docker 29.3.1) already supports `RUN --mount=type=cache` — verified by a
# throwaway build on the host 2026-08-12. Adding the directive would make every
# build pull `docker/dockerfile:1` over the network for zero gain.
#
# The `deps` stage that used to sit here was REMOVED 2026-08-12: nothing ever
# copied from it (`--from=deps` appears nowhere in this file, and compose sets
# no build `target:`), so BuildKit never even built it. Do not restore it.

# ─── Stage 1: builder ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build deps (devDependencies needed for build)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# `id=dr3-npm` namespaces the mount: CHAD-HQ is a ~15-tenant host and an
# unnamed mount defaults to an id derived from the target path, which every
# other stack's `/root/.npm` would then share. This restores the tarball cache
# after CHAD-HQ's nightly buildkit prune drops the npm layer, which is what put
# a ~200-270s reinstall tail on the first build of every day (ADR-0101).
RUN --mount=type=cache,id=dr3-npm,target=/root/.npm npm ci

COPY . .
# Bake the deploy identity (ADR: alerts must show the real SHA, not package.json 0.1.0).
# node:22-slim has no git binary — parse .git directly (works for both detached and ref HEADs).
RUN sh -c 'SHA=$(cat .git/HEAD 2>/dev/null); case "$SHA" in ref:*) SHA=$(cat .git/$(echo "$SHA" | cut -d" " -f2) 2>/dev/null);; esac; printf "{\"sha\":\"%s\",\"builtAt\":\"%s\"}" "${SHA:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .build-info.json; cat .build-info.json'
# Prisma client generation only parses the schema; it never opens a connection.
# Provide a syntactically valid placeholder DATABASE_URL so `env("DATABASE_URL")`
# resolves at build time. Runtime gets the real URL from the orchestrator.
RUN DATABASE_URL='postgresql://build:build@127.0.0.1:5432/build?schema=public' npx prisma generate
# Next.js type-check + build OOMs on the default Node heap once the codebase
# crosses Sprint-2 size (24k+ LOC). Raise the heap for the build stage only;
# this ENV does not carry into the runner stage (separate FROM). Required for
# both manual host builds and the fleet auto-deployer. (Codified 2026-06-06.)
ENV NODE_OPTIONS=--max-old-space-size=8192
# THE expensive step: this line preceded by `COPY . .` re-executes on EVERY
# commit, so it never hit the Docker layer cache — 93 pages / 191 API routes /
# 266k LOC recompiled from scratch, ~787s of a ~853s build. Next.js keeps its
# compiler cache in `.next/cache` ("a cache to .next/cache that is shared
# between builds" — Next.js CI build-caching docs); `.dockerignore` excludes
# `.next`, so nothing carried it in. This mount persists it host-side between
# builds. `sharing=locked` serializes concurrent builds instead of letting two
# writers interleave into one cache directory. Type-checking STAYS in this
# step by explicit decision — it is the payroll type-lie gate (ADR-0101).
#
# Nothing COPYs `.next/cache` into the runner, so this is a build-time-only
# change with no runtime surface.
RUN --mount=type=cache,id=dr3-next-cache,target=/app/.next/cache,sharing=locked npm run build
# Compile the standalone MyMRC scrape worker (TS → CJS) for the cron
# container. The Next.js standalone bundle does NOT include arbitrary
# `src/lib/` modules — only what Next's tracer reaches from app routes.
# The scrape worker is invoked from `scripts/mymrc-cron.mjs` (outside
# Next), so it gets its own emit step into `dist/mymrc/` and is COPY'd
# into the runner. See `tsconfig.mymrc.json` for the compile scope.
RUN npx tsc --project tsconfig.mymrc.json

# ─── Stage 2: runner (production) ────────────────────────────────────────
# Base image version MUST match the resolved `playwright` package version in
# package-lock.json. The npm caret (^1.48.0) resolved up to 1.59.1; the v1.48.0
# base ships browsers Playwright 1.59.1 can't find ("Executable doesn't exist"),
# which crash-loops the mymrc-scrape cron AND breaks the bonus-PDF render (both
# call browserType.launch). Keep this tag in lockstep with the lockfile on every
# Playwright bump. (Fixed 2026-06-06.)
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.build-info.json ./.build-info.json
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
# Prisma CLI + engines for the migration init container. The Next.js
# standalone bundle does not include these packages by itself.
# NOTE: do NOT copy `node_modules/.bin/prisma` separately — that
# entry is a symlink to ../prisma/build/index.js, and Docker's COPY
# resolves the symlink target into a regular file at the destination.
# When the resulting flat file runs, its `__dirname`-relative
# `prisma_schema_build_bg.wasm` lookup resolves into `.bin/` instead
# of `prisma/build/` and 404s. The migrate compose service
# invokes the binary via its explicit module path
# (`node node_modules/prisma/build/index.js`) which sidesteps the
# whole .bin/ resolution chain.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
# papaparse is used by `prisma/seed.mjs`. The Next.js standalone bundle
# omits it because no server code imports it; add it explicitly so the
# `migrate` init container can run `node prisma/seed.mjs`.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/papaparse ./node_modules/papaparse
# AWS SDK v3 — used by `src/lib/r2.ts` for the operator photo flow
# (presigned-URL minting). The Next.js standalone bundle does pick
# these up because server code imports them, but the route runs in
# the Node runtime and benefits from having the full package
# directories available for any optional sub-imports.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@aws-sdk ./node_modules/@aws-sdk
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@smithy ./node_modules/@smithy
# scripts/ — operational wrappers invoked by the migrate init container
# (e.g. scripts/migrate-with-ntfy.mjs) and the mymrc-scrape cron container
# (`scripts/mymrc-cron.mjs` + `scripts/mymrc-scrape.mjs`). The Next.js
# standalone bundle does not include scripts/ since no server code
# imports it; copy it explicitly so init-container commands like
# `node scripts/migrate-with-ntfy.mjs` resolve at runtime. Skipping
# this copy is what broke the 2026-05-06 deploy of PR #3 — the
# wrapper hit MODULE_NOT_FOUND, the migrate container exited 1, and
# the app's depends_on chain blocked the site from starting until
# the compose command was hand-reverted on CHAD-HQ.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# dist/mymrc — pre-compiled CJS output of `src/lib/mymrc/*.ts`, consumed
# by the `mymrc-scrape` cron container. The Next.js standalone bundle
# does not include this tree (no app route imports it), so we copy it
# explicitly. Ship `playwright` + its browser binaries with the runner
# image (the base image `mcr.microsoft.com/playwright:v1.59.1-jammy`
# already provides the browsers; the npm package itself is added below).
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/playwright-core ./node_modules/playwright-core

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1))"

CMD ["node", "server.js"]
