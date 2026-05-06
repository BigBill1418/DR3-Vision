# ADR-0013: Production deploy pattern

**Date:** 2026-05-06
**Status:** Accepted
**Supplements:** ADR-0002 (fleet host), ADR-0003 (domain & routing)
**Supersedes:** none

## Context

T-001 ships the brand-correct placeholder publicly. That forced four
production-deploy decisions that the charter and the prior ADRs had not
nailed down:

1. **Where production compose lives in the repo.** The local-dev
   `docker-compose.yml` (Postgres + MinIO + optional containerized app)
   already exists in the repo root and is referenced from `HANDOFF.md`
   for the dev workflow. Production needs a separate file.
2. **Whether dr3-vision gets its own Cloudflare tunnel or piggybacks
   on an existing SVDP tunnel** (svdp-intranet, svdp-guardian).
3. **Where the cloudflared process runs** — host-systemd (the
   svdp-intranet pattern, ADR-0008 in noc-master) or in-compose
   sidecar (the helix-hub / droneops pattern).
4. **What the `/healthz` contract is at T-001** when no DB or R2
   exist yet.

## Decisions

### 1. Production compose file at `deploy/docker-compose.yml`

The local-dev compose stays at the repo root and is invoked as
`docker compose up -d postgres minio` per `HANDOFF.md` Step 3.

The production compose lives at `deploy/docker-compose.yml`. The NOC
swarmpilot_deployer is configured with `compose_file:
deploy/docker-compose.yml` per the same convention DroneOpsMap uses
(`compose_file: infra/docker-stack.yml`).

Inside `deploy/docker-compose.yml`, `build.context: ..` resolves the
build context to the repo root so the Dockerfile, `package.json`,
`prisma/`, and `src/` are reachable. The deployer invokes compose
with `-f deploy/docker-compose.yml` (no `--project-directory`); the
project directory defaults to `deploy/` which makes `context: ..`
resolve correctly.

### 2. Dedicated Cloudflare tunnel per service

DR3-Vision gets its own tunnel: `dr3-vision`
(`3999bb3b-7f86-4896-8f8c-77ef27f8f2cf`). This matches the
one-tunnel-per-service pattern across the fleet (Helix-Hub,
DroneOpsCommand, EyesOn, Guardian, etc. all have their own tunnels).
Sharing a tunnel with svdp-intranet was considered but rejected
because:

- ADR-0008 in noc-master surfaces the multi-tunnel hostname-conflict
  trap; clean isolation eliminates that whole class of incident.
- Tunnel rollback (revoke + re-issue token) becomes scoped to one
  service rather than coupled to an unrelated WordPress stack.
- Per-service ntfy + CF Healthcheck routing is cleaner with a 1:1
  service-to-tunnel map.

### 3. Cloudflared as in-compose sidecar (NOT host-systemd)

The cloudflared process runs as a service inside the production
`docker-compose.yml` (image `cloudflare/cloudflared:2026.3.0`,
token sourced from `~/.dr3-vision-secrets/tunnel.env` on the host
via `env_file:`).

The svdp-intranet pattern (cloudflared as host-systemd, _outside_
compose) was a corrective response to a multi-tunnel collision
specific to that migration. For a fresh service that does not share
a hostname with any other tunnel, the in-compose sidecar pattern is
cleaner because:

- App + edge come up and down atomically. Rolling back the app rolls
  back the cloudflared on the same compose `down`.
- The deployer's `docker compose up -d` covers both services in one
  call; no separate systemd-unit choreography.
- The sidecar reaches the app over the compose bridge by service
  name (`http://app:3000`), so the app exposes no host port. This
  means `dr3-vision-app` cannot be probed from the LAN — only via
  the tunnel — which is the correct security posture.

### 4. `/healthz` contract grows with subsystems

T-001 ships a minimal `/healthz` that returns `{ ok, version,
uptime_s }` with HTTP 200 unconditionally. The Dockerfile
HEALTHCHECK and CF Healthcheck both probe this route. The response
shape grows as subsystems land:

- **T-002 (Postgres):** add `db_ok` (boolean) — drives 503 if the
  `SELECT 1` round-trip fails.
- **T-007 (R2):** add `r2_ok` (boolean) — drives 503 if the bucket
  HEAD fails.

The contract that `docs/FLEET-DEPLOYMENT.md` §"Healthcheck"
promises (`{ ok, version, uptime_s, db_ok, r2_ok }`) is the T-007
target shape, not the T-001 shape.

## Consequences

- The deployer auto-deploys on every push to `main` once the
  noc-master `data/config.yml` entries are in place. Manual
  intervention is only needed for secret rotations (tunnel token,
  future env vars).
- Tunnel-token rotation is a CF API mint + token-file replace +
  `docker compose up -d cloudflared` — atomic with one command.
- The CF Healthcheck for dr3-vision is operator click-through (the
  `cfat_NMVPYw…` token lacks the `Health Checks:Edit` scope per
  the existing fleet inventory). Listed as a TBD entry in
  `noc-master/data/cf-healthchecks.yml`.
- T-002's first migration adds `postgres` to
  `deploy/docker-compose.yml` and the corresponding `db_ok` probe
  to `/healthz`. ADR-0013 is supplemented at that point, not
  superseded.

## References

- `noc-master/CLAUDE.md` — deployer architecture
- `noc-master/data/config.yml` — services + deployer.repos entries
  for dr3-vision
- `noc-master/data/cf-healthchecks.yml` — `dr3-vision-public`
  operator-pending probe
- `noc-master/data/ntfy-fallback-topics.yml` — dr3-vision fallback
- `docs/FLEET-DEPLOYMENT.md` — healthz contract target
- `CHANGELOG.md` — 2026-05-06 ship entry
