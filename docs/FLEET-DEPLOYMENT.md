# Fleet deployment

This document covers everything needed to deploy DR3-Vision to the BarnardHQ fleet. ADR-0002 (CHAD-HQ host) and ADR-0003 (domain & routing) are the architecture decisions; this is the operational runbook.

## Target environment

- **Host:** CHAD-HQ
- **Public hostname:** `dr3-vision.svdp.us`
- **Tunnel:** Cloudflare Tunnel, configured per fleet conventions
- **Networks:** SVDP-Guardian, SVDP-Intranet, SVDP-Site
- **Deployment mechanism:** swarmpilot_deployer auto-deploys from `main` branch

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

### ntfy
- `NTFY_BASE_URL=https://ntfy.svdp.us`
- `NTFY_SYSTEM_TOPIC=dr3-vision-system`
- `NTFY_CONTAINER_TOPIC=dr3-vision-container`
- `NTFY_BEARER_TOKEN=<token>`

### Email (password reset)
- `RESEND_API_KEY=<resend api key>`
- `EMAIL_FROM=no-reply@dr3-vision.svdp.us`

## Build pipeline

Triggered on every push to `main`:

1. **Lint + type check** — `npm run lint && npm run typecheck`
2. **Test** — `npm test && npx playwright test`
3. **Build image** — `docker build -t ghcr.io/bigbill1418/dr3-vision:${SHA}`
4. **Push image** — to GHCR
5. **swarmpilot_deployer notification** — pulls latest tag on CHAD-HQ
6. **Deploy** — docker compose pull && docker compose up -d
7. **Healthcheck** — wait for `/healthz` returns 200, fail deploy and rollback otherwise
8. **Audit** — log deploy actor, SHA, timestamp to audit_log

## Backups

Postgres: backed up via `barnardhq_backup` per fleet conventions. Retention 30 days locally + offsite.

R2 photos: replicated by Cloudflare across regions (default). For disaster recovery, R2 supports point-in-time replication; not configured by default. Decision deferred until first compliance audit reveals whether MRC requires it.

Audit log: lives in Postgres, included in standard Postgres backups. Indefinite retention (ADR-0007).

## Logs and traces

- All application logs go to Loki via the standard fleet logger
- Traces go to Tempo via OpenTelemetry
- Metrics scraped from `/metrics` by Prometheus, dashboarded in Grafana

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

1. swarmpilot_deployer detects healthcheck failure (or manual rollback trigger via `barnardhq_rollback dr3-vision`)
2. Pulls the previous image tag
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
- [ ] GHCR repo `bigbill1418/dr3-vision` configured for image push
- [ ] swarmpilot_deployer wired to the `main` branch
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
