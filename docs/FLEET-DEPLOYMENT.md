# Fleet deployment

This document covers everything needed to deploy DR3-Vision to the BarnardHQ fleet. ADR-0002 (CHAD-HQ host) and ADR-0003 (domain & routing) are the architecture decisions; this is the operational runbook.

## Target environment

- **Host:** CHAD-HQ
- **Public hostname:** `dr3-vision.svdp.us`
- **Tunnel:** Cloudflare Tunnel, configured per fleet conventions
- **Networks:** SVDP-Guardian, SVDP-Intranet, SVDP-Site
- **Deployment mechanism:** swarmpilot_deployer auto-deploys from `main`. The
  deployer SSHes to CHAD-HQ, `git pull`s this repo, and runs `docker compose up -d`
  from the repo root (this builds the **local** image `dr3-vision-app:local` from
  the `build:` directive — there is **no GHCR registry image and no image pull**).
  Configured in `~/noc-master/data/config.yml` under `deployer.repos[]`
  (`type: compose`, `stack: dr3-vision`, `enabled: true`, `compose_up_timeout: 900`).

## Required environment variables

All env vars are documented in `.env.example`. The following are **required** for production:

### Application

- `NODE_ENV=production`
- `NEXTAUTH_URL=https://dr3-vision.svdp.us`
- `NEXTAUTH_SECRET=<random 32-byte hex>` — Auth.js session signing
- `DATABASE_URL=postgresql://dr3:<password>@postgres:5432/dr3_vision`

### R2 (photo storage)

- `R2_ACCOUNT_ID=<cloudflare account id>`
- `R2_ACCESS_KEY_ID=<r2 access key>`
- `R2_SECRET_ACCESS_KEY=<r2 secret>`
- `R2_BUCKET=dr3-vision-photos`
- `R2_PUBLIC_BASE_URL=https://photos.dr3-vision.svdp.us` (for signed URL prefix)

### MyMRC (Playwright)

- `MYMRC_CA_USERNAME=<woodland service account email>`
- `MYMRC_CA_PASSWORD=<woodland service account password>`
- `MYMRC_OR_USERNAME=<eugene service account email>`
- `MYMRC_OR_PASSWORD=<eugene service account password>`

### Observability

- `GLITCHTIP_DSN=<dsn for error tracking>`
- `LOKI_ENDPOINT=http://loki:3100` (fleet-internal)
- `TEMPO_ENDPOINT=http://tempo:4318/v1/traces`

### ntfy (fleet standard — ADR-0036)

- `NTFY_BASE_URL=https://ntfy.barnardhq.com` — the self-hosted fleet ntfy
  (NOT `ntfy.svdp.us`). On primary failure `src/lib/ntfy.ts` falls back to the
  obscured public `ntfy.sh` topic from `~/noc-master/data/ntfy-fallback-topics.yml`.
- `NTFY_SYSTEM_TOPIC=dr3-vision-system`
- `NTFY_PUBLISHER_TOKEN=<token>` — the bearer token `src/lib/ntfy.ts` reads
  (`process.env.NTFY_PUBLISHER_TOKEN`). Lives in `~/.dr3-vision-secrets/ntfy.env`
  (mode 600, NOT in the repo); the app boots fail-soft and treats a missing token
  as a no-op. (Earlier drafts referenced `NTFY_BASE_URL=ntfy.svdp.us`,
  `NTFY_CONTAINER_TOPIC`, and `NTFY_BEARER_TOKEN` — none of those match the code.)

### Email (password reset)

- `RESEND_API_KEY=<resend api key>`
- `EMAIL_FROM=no-reply@dr3-vision.svdp.us`

## Build pipeline (as actually deployed)

There is **no GHCR registry image and no CI image push**. The image
`dr3-vision-app:local` is built **on CHAD-HQ** by `docker compose up -d` (the
`build:` directive in the root `docker-compose.yml`). The swarmpilot_deployer
polls this repo every ~5s and, on a new `main` commit:

1. **Fetch** — deployer SSHes to CHAD-HQ and `git pull --rebase`s this repo.
2. **migrate** — the one-shot `dr3-vision-migrate` container runs
   `prisma migrate deploy` (gated by `depends_on` so a failed migration aborts
   the deploy before the app starts).
3. **Build + deploy** — `docker compose up -d --remove-orphans` from the repo
   root rebuilds `dr3-vision-app:local` and (re)starts `app` + `cloudflared`
   (`compose_up_timeout: 900` — the multi-stage Playwright build can take 6–8 min
   on a cold cache).
4. **Healthcheck** — the deploy gate waits for `/healthz` to return 200; on
   failure it rolls back and pings `dr3-vision-system` (ntfy).
5. **Audit** — deploy actor, SHA, timestamp logged.

Lint / typecheck / unit + Playwright tests run in the dev loop and in any GitHub
Actions CI configured on the repo; they are **not** part of the deployer's
on-host deploy step (the deployer builds and health-gates, it does not re-run the
test suite on CHAD).

> The aspirational GHCR build→push→pull pipeline that earlier drafts of this doc
> described was never wired. The deployer's remote-host path builds locally; see
> `~/noc-master/data/config.yml` `deployer.repos[]` (no `compose_file:`, no
> registry image) and ADR-0013 in this repo for why the prod compose is at the
> repo root.

## Backups

Postgres: backed up via `barnardhq_backup` per fleet conventions. Retention 30 days locally + offsite.

R2 photos: replicated by Cloudflare across regions (default). For disaster recovery, R2 supports point-in-time replication; not configured by default. Decision deferred until first compliance audit reveals whether MRC requires it.

Audit log: lives in Postgres, included in standard Postgres backups. Indefinite retention (ADR-0007).

## Logs and traces

- All application logs go to Loki via the standard fleet logger
- Traces go to Tempo via OpenTelemetry
- Metrics scraped from `/metrics` by the fleet Prometheus (on BOS-HQ),
  dashboarded in Grafana (`grafana/dashboards/dr3-vision.json`, uid `dr3-vision`).
  **The scrape is over WireGuard, not the tunnel:** `/metrics`
  (`src/app/metrics/route.ts`) returns 404 to any request carrying a
  `cf-connecting-ip` header, so it is reachable only off-tunnel. The compose
  binds the app container's `:3000` to `10.99.0.2:9469` (CHAD WG IP only) for the
  scrape; Prometheus targets `10.99.0.2:9469`. No bearer token — the IP-header
  guard is the auth boundary. The InfraWatch side is wired in
  `infrawatch/settings-api/main.py` (job `dr3-vision`) + `infrawatch/data/config.yml`
  (the `/healthz` blackbox tile) — see InfraWatch ADR-0016.

## Healthcheck

`GET /healthz` returns:

- `200 { ok: true, version: "X.Y.Z", uptime_s: N, db_ok: true, r2_ok: true }` if all systems are ok
- `503 { ok: false, version: "X.Y.Z", db_ok: false, ... }` if any subsystem is failing

The healthcheck checks:

- Database reachability (a `SELECT 1`)
- R2 reachability (a HEAD on the bucket)
- That the application can serve a static asset

## TLS, CSP, and security headers

Configured at the application layer (not just at Cloudflare):

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Content-Security-Policy: default-src 'self'; img-src 'self' https://*.r2.cloudflarestorage.com data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`

The Permissions-Policy explicitly allows camera + microphone (for photo capture and voice-to-text); excludes geolocation (we do not track operator location).

## Rollback procedure

1. swarmpilot_deployer detects healthcheck failure (or a manual rollback trigger)
2. **Rolls the working tree back** to the previous good commit (`git reset --hard`
   to the prior SHA) and re-runs `docker compose up -d`, which rebuilds
   `dr3-vision-app:local` from that earlier source. Because the image is built on
   the host (no registry tags), rollback is source-level, not image-tag-level.
3. Restarts containers
4. Healthcheck verifies; if failing again, halts and pings Bill via ntfy `dr3-vision-system`

Database migrations are forward-only; rollback of the database is not automatic. If a migration is bad, write a forward-fixing migration. Do not attempt to rollback Prisma migrations in production.

## Production seeding

The seed CSVs in `prisma/seed/` run on every fresh database. For production, the first deploy seeds; subsequent deploys do not re-seed (the seed is idempotent — it upserts, but `npx prisma db seed` is only invoked manually after the initial setup).

Manager and admin users are seeded as inactive with placeholder passwords; Bill resets each manager's password via the user-management UI before they receive the deploy announcement.

## First-deploy checklist

- [ ] Cloudflare DNS for `dr3-vision.svdp.us` created
- [ ] Cloudflare Tunnel route configured pointing to CHAD-HQ
- [ ] All env vars set in CHAD-HQ secrets store
- [ ] R2 bucket `dr3-vision-photos` created with appropriate CORS
- [ ] MyMRC service accounts created and credentials confirmed working
- [ ] swarmpilot_deployer wired to the `main` branch (`enabled: true` in
      `~/noc-master/data/config.yml` `deployer.repos[]` — already done 2026-05-06)
      — the deployer builds `dr3-vision-app:local` on CHAD; no registry image to push
- [ ] First image pushed and deployed
- [ ] Healthcheck returning 200
- [ ] Database migrated and seeded
- [ ] Bill, Kelsey, Morena, Rick, Janette accounts created and passwords distributed
- [ ] Test PIN flow works end-to-end on a real iPad

## Subsequent deploys

For routine deploys, swarmpilot_deployer handles everything. Manual intervention is only needed for:

- Schema migrations that require manual data backfill
- Secret rotations
- Feature flags toggles

## References

- ADR-0001 (tech stack)
- ADR-0002 (fleet host)
- ADR-0003 (domain & routing)
- FLEET-PRIMER (in transcripts/uploads, fleet conventions)
- Charter §7 (Deployment), §8 (Operational considerations)
