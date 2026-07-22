# Fleet observability setup

Operator-side procedure for wiring DR3-Vision into the BarnardHQ fleet observability stack (GlitchTip, Loki, Tempo, Grafana, Prometheus). Companion to ADR-0022.

**Who does this:** Bill, or anyone with fleet admin access.

**When:** Once, before T-123 ships. Endpoint changes within the fleet (e.g., Tempo upgrade) require updating env vars and recreating the container.

---

## Prerequisites

- SSH access to CHAD-HQ
- Access to the fleet's GlitchTip web UI (typically `https://glitchtip.barnardhq.com`)
- Access to the fleet's Grafana (typically `https://grafana.barnardhq.com`)
- Knowledge of the fleet's standard ingest endpoints for Loki, Tempo, Prometheus (documented in FLEET-PRIMER)

## Step 1 — Create the `dr3-vision` GlitchTip project

In the GlitchTip web UI:

1. Navigate to **Projects → + Create Project**
2. Configure:
    - **Platform:** Node.js
    - **Project name:** `dr3-vision`
    - **Slug:** `dr3-vision` (lowercase, no spaces)
    - **Team:** assign to the team that includes Bill (and any future maintainers)
3. Click **Create Project**
4. The DSN appears on the project page. It looks like:
   ```
   https://<32-char-hex>@glitchtip.barnardhq.com/<project-numeric-id>
   ```
5. **Copy the DSN** — you'll need it in step 4

For source map upload during production builds, generate an auth token:

6. Navigate to **Profile → Auth Tokens**
7. Click **+ Create New Token**
8. Scopes: `project:read`, `project:releases`, `org:read`
9. Description: `dr3-vision source map uploads`
10. **Copy the token value** — it's only shown once

## Step 2 — Confirm fleet endpoints

The endpoint URLs depend on your fleet's internal networking. Check FLEET-PRIMER for the canonical values. The defaults assumed by DR3-Vision:

| Subsystem | Default endpoint | What it does |
|---|---|---|
| Tempo (traces) | `http://tempo:4318/v1/traces` | OTLP HTTP trace ingest |
| Loki (logs) | (stdout → Promtail/Alloy sidecar → Loki) | No direct endpoint from DR3-Vision; agent picks up stdout |
| Prometheus | (Prometheus scrapes `dr3-vision:3000/metrics`) | Pull, not push |
| Grafana | `https://grafana.barnardhq.com` | UI only; no code-side endpoint needed |

If your fleet uses different hostnames, override via env vars in step 4.

## Step 3 — Configure the fleet Prometheus scraper

In the fleet's Prometheus config (typically in the noc-master repo or wherever your fleet manages scrape configs), add a scrape job for DR3-Vision:

```yaml
# prometheus.yml (excerpt)
scrape_configs:
  - job_name: 'dr3-vision'
    scrape_interval: 30s
    static_configs:
      - targets: ['dr3-vision:3000']
    metrics_path: '/metrics'
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
        replacement: 'dr3-vision'
```

Reload Prometheus to pick up the new job:

```bash
# From the Prometheus container or host
curl -X POST http://prometheus:9090/-/reload
```

**Verify:** in Grafana **Explore → Prometheus**, run:

```promql
up{job="dr3-vision"}
```

It returns `0` if DR3-Vision isn't reachable yet (expected before step 5), and `1` once the container is healthy and reachable.

## Step 4 — Drop observability env file on CHAD-HQ

SSH to CHAD-HQ:

```bash
ssh chad-hq

mkdir -p ~/.dr3-vision-secrets
chmod 700 ~/.dr3-vision-secrets

cat > ~/.dr3-vision-secrets/observability.env <<'EOF'
# Fleet observability wire-in (ADR-0022)

# GlitchTip — errors
GLITCHTIP_DSN=<paste DSN from step 1>
GLITCHTIP_AUTH_TOKEN=<paste auth token from step 1, for source map upload>

# OpenTelemetry — traces to Tempo
TEMPO_ENDPOINT=http://tempo:4318/v1/traces
OTEL_TRACE_SAMPLE_RATE=0.01

# Logging level (info in production, debug in development)
LOG_LEVEL=info
EOF

chmod 600 ~/.dr3-vision-secrets/observability.env
```

## Step 5 — Ensure docker-compose loads the env file

Edit `~/dr3-vision/docker-compose.yml` (or wherever the production compose lives) to include the observability env file in the `app` service:

```yaml
services:
  app:
    # ... existing config ...
    env_file:
      - ${HOME}/.dr3-vision-secrets/observability.env
      - ${HOME}/.dr3-vision-secrets/entra.env
      - ${HOME}/.dr3-vision-secrets/m365.env
      - ${HOME}/.dr3-vision-secrets/ntfy.env
      - ${HOME}/.dr3-vision-secrets/mymrc-cred-key.env
```

The order matters only if there are key conflicts (later files win). There shouldn't be any.

## Step 6 — Recreate the container

```bash
cd /opt/dr3-vision  # or wherever the compose file lives
docker compose up -d --force-recreate --no-deps app
```

Watch the logs for initialization:

```bash
docker compose logs -f app | head -100
```

Expect to see, in order:

```
[observability] OpenTelemetry SDK started (service=dr3-vision env=production)
[observability] GlitchTip initialized (DSN configured)
[observability] Prometheus registry initialized
[ntfy] Container start published
[next] ready - started server on 0.0.0.0:3000
```

If any of the observability lines say "DSN not set" or "endpoint not configured", the env file isn't being loaded correctly. Inspect with:

```bash
docker compose exec app env | grep -E '(GLITCHTIP|TEMPO|LOG_LEVEL)'
```

## Step 7 — Verify each subsystem

### 7a. GlitchTip — errors

Hit the admin-gated test-error endpoint (T-123). It deliberately throws,
which GlitchTip captures when `GLITCHTIP_DSN` is configured. It is gated to
`role=admin` (an open error-trigger would be an abuse/DoS vector), so you
must send a valid admin session cookie:

```bash
# -b "<cookie>" carries an admin session; the route returns 500 on the
# deliberate throw, and the error lands in GlitchTip within ~30s.
curl -b "authjs.session-token=<admin-session-cookie>" \
  https://dr3-vision.svdp.us/api/admin/_test-error
```

Without a valid admin cookie the route returns 401/403 and nothing is
reported — that gate is intentional. Within 30 seconds of an authenticated
admin hit, the error should appear in GlitchTip → Issues. The stack trace
should be readable (source maps uploaded if `GLITCHTIP_AUTH_TOKEN` was set
during build).

### 7b. Tempo — traces

Make any request to DR3-Vision:

```bash
curl https://dr3-vision.svdp.us/healthz
```

In Grafana → Explore → Tempo, search for `service.name = dr3-vision` over the last 5 minutes. You should see the request trace with auto-instrumented spans for HTTP, Prisma queries, and any outbound fetches.

### 7c. Loki — logs

In Grafana → Explore → Loki:

```logql
{service="dr3-vision"} | json
```

You should see structured JSON logs flowing in real-time. Each log line should have `service`, `version`, `env`, `level`, `time`, and the message body.

If logs aren't appearing, Promtail (or Alloy, depending on your fleet) on CHAD-HQ isn't tailing the dr3-vision container. Check the agent's config and reload it.

### 7d. Prometheus — metrics

From inside the fleet network (or via SSH tunnel):

```bash
curl http://chad-hq:3000/metrics
```

Should return Prometheus text format. Verify a few key metrics are present:

```
dr3_vision_http_requests_total{...}
dr3_vision_http_request_duration_seconds_bucket{...}
process_cpu_user_seconds_total
nodejs_heap_size_total_bytes
```

**Critical safety check:** confirm the public Cloudflare tunnel does NOT expose `/metrics`:

```bash
curl https://dr3-vision.svdp.us/metrics
# Expected: 404 Not Found
```

The middleware check on `cf-connecting-ip` should reject any request that came through Cloudflare. If this returns 200 with metrics, the middleware is misconfigured — fix before continuing.

### 7e. Grafana — dashboard

In Grafana, navigate to **Dashboards → Browse → DR3 Vision**.

The dashboard should render with live data. If it doesn't appear:

- The dashboard JSON file `grafana/dashboards/dr3-vision.json` must be in the fleet's provisioning path
- Reload Grafana provisioning: `curl -X POST http://grafana:3000/api/admin/provisioning/dashboards/reload` (or restart the Grafana container)

## Step 8 — Configure alerts

In Grafana → Alerting → Alert rules, import or verify the alerts defined in `grafana/alerts/dr3-vision.yaml`:

- `dr3-vision-db-down` — fires when `up{job="dr3-vision"}` is 0 for 1 min
- `dr3-vision-error-rate-high` — fires when 5xx rate exceeds 5% over 5 min
- `dr3-vision-healthz-degraded` — fires when /healthz returns non-200 for 2 min

Verify the contact point is configured to route to ntfy:

- Contact point: `ntfy-dr3-vision-system`
- Webhook URL: `https://ntfy.barnardhq.com/dr3-vision-system`
- HTTP method: POST
- Headers: `Authorization: Bearer <publisher-token>`, `Title: Grafana Alert`

Send a test alert from Grafana to verify the ntfy routing works end-to-end. Bill should see the test on his phone.

## Step 9 — Health pill verification in Vision Dashboard

After all subsystems are wired, log into the Vision Dashboard as Bill. The footer pill should show "All systems operational" in green. Tap to expand; verify each subsystem reports green with a recent timestamp.

Simulate degradation (e.g., kill the Tempo container briefly) and confirm the pill transitions to amber with the right subsystem flagged.

## Troubleshooting

### GlitchTip shows "Unknown" for environment / release

`NODE_ENV` and `GIT_SHA` env vars not set. The deployer should set `GIT_SHA` automatically; `NODE_ENV` should be `production` in the production image. Check the container's env.

### Tempo traces show "service.name = unknown"

The OpenTelemetry SDK initialized before the resource attributes were set. Confirm `src/instrumentation.ts` sets the resource attributes BEFORE calling `sdk.start()`.

### Loki shows logs but they're all "level": "info" with no detail

`pino` is logging but the middleware isn't adding `request_id` correlation. Check `src/middleware.ts` for the request_id setup.

### Prometheus scrape returns empty body

The `/metrics` endpoint exists but the registry has no metrics registered. Confirm `src/lib/observability/metrics.ts` is imported by at least one server-side module (the metrics registry initialization needs to run).

### Source maps don't upload during build

`GLITCHTIP_AUTH_TOKEN` not set at build time. CI/swarmpilot_deployer must inject this env var. Confirm it's in the deployer's secrets store.

## Rotation

GlitchTip auth token: rotate yearly. Update `GLITCHTIP_AUTH_TOKEN` in the env file, recreate the container.

The DSN itself does NOT rotate (it's tied to the project, not a user). Only the auth token (for source map upload) needs rotation.

## References

- ADR-0022 (Fleet observability wire-in — architecture)
- `docs/COMPLIANCE.md` (alert routing matrix — ntfy vs in-app)
- FLEET-PRIMER (fleet conventions, exact endpoints, agent configs)
- GlitchTip docs: https://glitchtip.com/documentation
- OpenTelemetry Node.js: https://opentelemetry.io/docs/instrumentation/js/getting-started/nodejs/
- Pino docs: https://getpino.io/
