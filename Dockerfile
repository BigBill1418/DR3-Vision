# DR3-Vision production Dockerfile
# Multi-stage: deps → builder → runner
# Target image size: ~300MB (includes Playwright browser binaries)

# ─── Stage 1: deps ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Install build dependencies for argon2 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── Stage 2: builder ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build deps (devDependencies needed for build)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
# Prisma client generation only parses the schema; it never opens a connection.
# Provide a syntactically valid placeholder DATABASE_URL so `env("DATABASE_URL")`
# resolves at build time. Runtime gets the real URL from the orchestrator.
RUN DATABASE_URL='postgresql://build:build@127.0.0.1:5432/build?schema=public' npx prisma generate
RUN npm run build

# ─── Stage 3: runner (production) ────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
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

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1))"

CMD ["node", "server.js"]
