# ADR-0022: Fleet observability wire-in

**Date:** 2026-06-05
**Status:** Accepted
**Supersedes:** T-018 deferral (was V2.1 backlog, now Sprint 2 core)

## Context

The BarnardHQ fleet runs a standardized observability stack: **GlitchTip** (errors), **Loki** (logs), **Tempo** (traces), **Grafana** (dashboards), **Prometheus** (metrics scrape), **ntfy** (alerts). Every service in the fleet is expected to participate in this stack so that:

1. Errors are visible to operators without SSH'ing into the container
2. Logs are searchable across services from one place
3. Traces tie cross-service requests together for debugging
4. Dashboards provide at-a-glance health for the fleet
5. Alerts route through ntfy with consistent rules

DR3-Vision shipped Sprint 1 with **partial** observability:

- ✅ `/healthz` endpoint with deployer-compatible body format (existing)
- ✅ ntfy publisher for system-level events (existing, see `src/lib/ntfy.ts`)
- ✅ Container-start, migration-applied, unhandled-error publishes (existing, `src/instrumentation.ts`)
- ❌ OpenTelemetry SDK for traces — not wired
- ❌ GlitchTip Sentry-compatible SDK — not wired
- ❌ Loki structured log shipper — using stdout only
- ❌ Prometheus `/metrics` endpoint — does not exist
- ❌ Grafana dashboards — no JSON committed to fleet registry

T-018 in Sprint 1 was scoped to fix the last four. It was deferred to V2.1 backlog at the substantial-complete checkpoint. Bill has now reversed that decision: Sprint 2 ships with full fleet observability so that the Bonus Management cutover lands on a production-grade monitored platform from day one.

## Decision

Wire DR3-Vision into the full BarnardHQ observability stack as a Sprint 2 deliverable. Each subsystem gets a dedicated ticket (T-118 through T-122 in `docs/SPRINT-2-PLAN.md`).

### 1. OpenTelemetry SDK (traces → Tempo)

**Library:** `@opentelemetry/sdk-node` with auto-instrumentations for HTTP, Fetch, Prisma, Next.js.

**Wiring:** in `src/instrumentation.ts` (the existing Next.js instrumentation hook — extended, not replaced; the ntfy publish logic stays):

```typescript
// src/instrumentation.ts (extended)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // ─── OpenTelemetry: traces to Tempo ──────────────────────────────
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } =
      await import('@opentelemetry/auto-instrumentations-node');
    const { Resource } = await import('@opentelemetry/resources');
    const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions');

    const sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'dr3-vision',
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
      }),
      traceExporter: new OTLPTraceExporter({
        url: process.env.TEMPO_ENDPOINT ?? 'http://tempo:4318/v1/traces',
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
          '@opentelemetry/instrumentation-dns': { enabled: false }, // too noisy
        }),
      ],
    });

    sdk.start();

    // ─── Existing ntfy boot-publish + uncaught error handlers ────────
    await publishContainerStart();
    process.on('uncaughtException', (err) => {
      /* ...existing... */
    });
    process.on('unhandledRejection', (err) => {
      /* ...existing... */
    });

    // ─── Sentry/GlitchTip wiring (see §2 below) ──────────────────────
    await initGlitchTip();
  }
}
```

Sampling: 100% in development; **1% sampled + 100% error-spans** in production via `TraceIdRatioBased` sampler with custom error decorator. Tempo storage cost stays bounded; debugging fidelity for failures stays high.

### 2. GlitchTip (errors → Sentry-compatible API)

**Library:** `@sentry/nextjs` — GlitchTip implements the Sentry SDK API, so the official Sentry packages work against a GlitchTip DSN.

**Wiring:** `src/lib/observability/sentry.ts` (new) initializes the SDK with the fleet's GlitchTip DSN:

```typescript
// src/lib/observability/sentry.ts (new)
import * as Sentry from '@sentry/nextjs';

export async function initGlitchTip() {
  if (!process.env.GLITCHTIP_DSN) {
    console.log('[observability] GLITCHTIP_DSN not set, error reporting disabled');
    return;
  }

  Sentry.init({
    dsn: process.env.GLITCHTIP_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.GIT_SHA ?? 'dev',
    tracesSampleRate: 0, // Tempo handles traces; GlitchTip just errors
    profilesSampleRate: 0,
    beforeSend(event) {
      // Scrub sensitive fields per CLAUDE.md hard rule #8 + ADR-0007
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      if (event.contexts?.user) {
        delete event.contexts.user.ip_address;
      }
      // Never report PIN-related data
      if (event.tags?.has_pin) return null; // removed by Amendment 1: nothing set this tag
      return event;
    },
  });
}
```

Configuration files at the repo root (auto-generated by `@sentry/nextjs` init):

- `sentry.server.config.ts` — server-side init (calls the same `initGlitchTip`)
- `sentry.edge.config.ts` — edge runtime init (no-op for now; we don't use edge runtime)
- `sentry.client.config.ts` — browser-side init (catches client-side React errors)

The Sentry Next.js webpack plugin uploads source maps to GlitchTip on production builds so stack traces are useful. Source map upload is gated by `GLITCHTIP_AUTH_TOKEN` being set; without it, the upload step skips silently.

**Manual error reporting:** `Sentry.captureException(err)` and `Sentry.captureMessage(msg)` are available throughout the codebase for custom error paths. Most paths don't need manual reporting — unhandled errors are caught automatically by the SDK.

**Coordination with ntfy:** the existing `src/lib/ntfy.ts` unhandled-error publish stays. It fires for _system-level_ incidents (per CLAUDE.md hard rule #5). GlitchTip captures _every_ error including handled ones. The two are complementary:

- GlitchTip: every error, all roles, browse in fleet UI
- ntfy: only sufficiently severe errors, only Bill, mobile-push for immediate attention

The `Sentry.captureException()` call does not gate the ntfy publish — both fire on uncaught errors, both gate independently.

### 3. Loki (logs → log shipper)

**Approach:** the fleet's standard Promtail or Grafana Alloy agent runs as a sidecar (or on the host) and tails container stdout, shipping to Loki. DR3-Vision's contract is to emit **structured JSON logs** to stdout that Promtail can parse efficiently.

**Library:** `pino` — fast, JSON-native, well-supported in Next.js.

**Wiring:** `src/lib/observability/logger.ts` (new):

```typescript
// src/lib/observability/logger.ts (new)
import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({
      service: 'dr3-vision',
      version: process.env.GIT_SHA ?? 'dev',
      env: process.env.NODE_ENV,
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['*.password', '*.pin', '*.pin_hash', '*.authorization', 'req.headers.cookie'],
    censor: '[REDACTED]',
  },
});
```

**Convention:** all logs use the structured logger, never `console.log` in production paths. Top-level request handlers add a `request_id` field; child loggers inherit it.

```typescript
// Example usage
import { log } from '@/lib/observability/logger';

log.info({ user_id: session.user.id, month_id }, 'Bonus month signed');
log.warn({ retry_count: 3, error: err.message }, 'mymrc scrape retry');
log.error({ error_id: 'mail-send-failed', month_id }, 'Payroll PDF delivery failed');
```

**Existing `console.log` calls** in the Sprint 1 codebase are not bulk-converted (T-118 is not a full audit). New code uses `log`; old paths are migrated as they're touched.

### 4. Prometheus `/metrics` endpoint

**Library:** `prom-client` — the standard Node.js Prometheus client.

**Wiring:** `src/lib/observability/metrics.ts` (new) initializes the registry and defines custom metrics. The endpoint at `src/app/metrics/route.ts` (new) serves the registry's text output to Prometheus scrapes.

```typescript
// src/lib/observability/metrics.ts (new)
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'dr3-vision' });
collectDefaultMetrics({ register: registry });

// Custom DR3-Vision metrics
export const httpRequestsTotal = new Counter({
  name: 'dr3_vision_http_requests_total',
  help: 'Total HTTP requests by route, method, status',
  labelNames: ['route', 'method', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'dr3_vision_http_request_duration_seconds',
  help: 'HTTP request duration by route',
  labelNames: ['route', 'method'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  registers: [registry],
});

export const mymrcScrapeSuccess = new Counter({
  name: 'dr3_vision_mymrc_scrape_total',
  help: 'MyMRC scrape attempts by site and outcome',
  labelNames: ['site', 'outcome'],
  registers: [registry],
});

export const r2UploadSuccess = new Counter({
  name: 'dr3_vision_r2_upload_total',
  help: 'R2 upload attempts by kind and outcome',
  labelNames: ['kind', 'outcome'],
  registers: [registry],
});

export const offlineQueueDepth = new Gauge({
  name: 'dr3_vision_offline_queue_depth',
  help: 'Per-session offline queue depth (active operators)',
  labelNames: ['site', 'user_id'],
  registers: [registry],
});

export const bonusMonthsByState = new Gauge({
  name: 'dr3_vision_bonus_months_by_state',
  help: 'Bonus month counts by state',
  labelNames: ['site', 'state'],
  registers: [registry],
});

export const payrollDeliverySuccess = new Counter({
  name: 'dr3_vision_payroll_delivery_total',
  help: 'M365 mail-send attempts to payroll',
  labelNames: ['outcome'], // success | retry | failed
  registers: [registry],
});
```

```typescript
// src/app/metrics/route.ts (new)
import { registry } from '@/lib/observability/metrics';
import { NextResponse } from 'next/server';

// IMPORTANT: this endpoint is internal-only. Prometheus scrapes from inside
// the fleet network. Cloudflare tunnel does NOT expose /metrics publicly.
// If a request reaches here with a Cloudflare-Connecting-IP header, return 404.
export async function GET(req: Request) {
  const cfHeader = req.headers.get('cf-connecting-ip');
  if (cfHeader) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': registry.contentType },
  });
}
```

**Middleware integration:** the existing `src/middleware.ts` adds request counting / duration as a Next.js middleware hook (or in a wrapper around route handlers — see ticket T-121 for implementation choice).

### 5. Grafana dashboard

**One commit-tracked JSON file:** `grafana/dashboards/dr3-vision.json`.

This file is consumed by the fleet's Grafana provisioning. The fleet's dashboard registry watches a known path (configurable per-service per fleet convention) and auto-imports new versions when the file changes.

Dashboard panels (all in one tab, plus a "Bonus" sub-tab):

**Operational overview:**

- Request rate (1-minute moving avg) per route, p50/p95/p99 duration
- Error rate per route (4xx, 5xx)
- DB connection pool utilization
- Memory + CPU per container
- Active sessions (admin / manager / operator separately)

**MyMRC integration:**

- Hourly scrape success rate per site (rolling 24h, gauge for last 7d)
- Scheduled hauls upserted (rate)
- Stale-haul cancellations (rate)
- Last successful scrape per site (timestamp)

**Operator iPad path:**

- Inbound loads per hour per site
- Average dock-SLA timing per site (live)
- Photo uploads to R2 (rate, success vs failure)
- Offline queue depths (active operators with non-zero queue)

**Bonus Management (sub-tab):**

- Bonus months by state (gauge per state: draft, pending_signatures, partially_signed, signed, paid, amended)
- Daily entries today vs expected (gauge: pre-5pm warning at >50% missing)
- Payroll delivery success rate (rolling 30d)
- Time-from-second-signature-to-payroll-delivery (histogram)

**Cross-cutting:**

- ntfy publish rate by topic
- GlitchTip event ingest count (from GlitchTip itself, not from us)
- /healthz response status histogram

The dashboard's `uid` field is `dr3-vision` (stable identifier — links to it from other dashboards or notes stay valid across edits).

### 6. Alert routing (Grafana → ntfy)

The fleet's Grafana includes alert routing through Grafana Alerting. DR3-Vision's alerts route to ntfy via the fleet's existing webhook-to-ntfy bridge:

- **Critical** (db_ok false for >2 min, error rate >5% for >5 min, healthz down >1 min) → ntfy `dr3-vision-system` (Bill)
- **Warning** (MyMRC scrape failed last tick, R2 upload error rate >1%, payroll delivery retried) → in-app dashboard signal only, NOT ntfy

This matches the routing matrix in `docs/COMPLIANCE.md` (operational events stay in-portal; only system-level fires ntfy). Alert rules are defined in `grafana/alerts/dr3-vision.yaml`.

### 7. Env vars added

```bash
# OpenTelemetry
TEMPO_ENDPOINT=http://tempo:4318/v1/traces
OTEL_TRACE_SAMPLE_RATE=0.01  # 1% in production

# GlitchTip
GLITCHTIP_DSN=https://<key>@glitchtip.barnardhq.com/<project-id>
GLITCHTIP_AUTH_TOKEN=  # for source map upload during build

# Loki — emit via stdout (the agent ships it); no DR3-Vision-side endpoint
LOG_LEVEL=info  # debug in dev, info in production

# Prometheus — internal scrape; the fleet scraper config knows where to find /metrics

# Git SHA — injected at build time by swarmpilot_deployer
GIT_SHA=  # auto-set; falls back to 'dev'
```

All documented in `.env.example`. None are required for the application to start — observability fails open (logs to stdout, no traces, no errors reported, no metrics scraped). This matches existing patterns (ntfy publisher fails open without token; MyMRC scrape skips without credentials).

## Alternatives considered

- **Defer T-118 to V2.1 backlog as originally planned.** Rejected by Bill — bonus cutover deserves production-grade monitoring.
- **Use OpenTelemetry for everything (traces + logs + metrics).** OTel has all three signals, but the fleet's stack uses Loki for logs and Prometheus for metrics (not OTel-native equivalents). Aligning with fleet conventions is more valuable than signal consolidation.
- **Use Sentry SaaS instead of GlitchTip.** GlitchTip is the fleet standard. SaaS Sentry has more features but introduces external vendor dependency and cost.
- **Custom metrics agent (not Prometheus).** Standard Prometheus is the fleet convention; deviation costs operational complexity.
- **Skip source-map upload in production builds.** Stack traces without source maps are nearly useless for debugging. Upload time is ~10 seconds per build — worth it.

## Consequences

- The DR3-Vision container starts ~1 second slower due to SDK initialization. Acceptable.
- Memory overhead from OTel + Prometheus + Pino is ~30–50 MB. Acceptable on CHAD-HQ.
- Source map upload to GlitchTip during build means production builds need `GLITCHTIP_AUTH_TOKEN`. Without it, builds succeed without uploads (and GlitchTip stack traces are minified).
- The fleet's existing GlitchTip + Loki + Tempo + Grafana stack must have a `dr3-vision` project / index / namespace set up. This is operator setup, documented in `docs/operator/fleet-observability-setup.md`.
- Future fleet-wide observability changes (e.g., upgrading Tempo, changing log retention) are absorbed by DR3-Vision automatically because we ship to the fleet endpoints, not to specific configurations.
- The internal `/metrics` endpoint is reachable from inside the fleet network. The middleware check on `cf-connecting-ip` ensures it's not accidentally exposed via the Cloudflare tunnel. Operator runbook documents the verification step.

## Amendment 1 — 2026-11-11: the browser DSN is a BUILD-time value on the PUBLIC host

**Status:** Accepted (fix in review; inert until the CHAD-side value is set and the image is rebuilt).

**What was wrong.** §2 wired browser error capture, but no browser error from the Woodland/Eugene tablets ever
reached GlitchTip. Two gaps, either one enough on its own:

1. `NEXT_PUBLIC_GLITCHTIP_DSN` was never set at image build. Next inlines `NEXT_PUBLIC_*` into the client chunks
   when `next build` runs, and the Dockerfile had no `ARG` for it, so the shipped bundle contained the SDK and no
   DSN. A runtime `env_file` cannot fix this: the browser never sees container env.
2. The CSP `connect-src` (src/lib/csp.ts, ADR-0053 D3) allowed only `'self'` and R2. Even with a DSN baked in, the
   browser would have blocked the SDK's envelope POST to GlitchTip.

**Decision.**

- The browser DSN is a build argument: `Dockerfile` `ARG`/`ENV NEXT_PUBLIC_GLITCHTIP_DSN` (empty default) just
  before `next build`, fed by `docker-compose.yml` `app.build.args` from `${NEXT_PUBLIC_GLITCHTIP_DSN:-}`. This
  matches the fleet pattern (Helix-Hub and EyesOn pass `VITE_SENTRY_DSN` the same way).
- **Where the value lives:** only in the compose project env file on CHAD-HQ,
  `/home/bbarnard065/DR3-Vision/.env` (gitignored by `.env*`, excluded from the build context by
  `.dockerignore`). The deployer runs `docker compose --env-file .env build` there (noc-master ADR-0054/0123:
  `secrets.env` absent, `.env` present). It is never committed. The value is
  `NEXT_PUBLIC_GLITCHTIP_DSN=https://<publickey>@errors.barnardhq.com/26` (GlitchTip project 26 `dr3-vision`).
- **Public host only.** The tablets are not on WireGuard: the browser DSN must name `errors.barnardhq.com`
  (public through Cloudflare). Never `glitchtip.barnardhq.com` (10.99.0.4). The server DSN (`GLITCHTIP_DSN`,
  runtime env) is separate and unchanged.
- CSP `connect-src` adds `https://errors.barnardhq.com` and nothing else.
- The browser init moved from `sentry.client.config.ts` to `src/instrumentation-client.ts`. Next 15.3+ loads that
  file natively, and `@sentry/nextjs` 10 logs a deprecation warning for the old file. (Next 15.5 inlined the old
  bracket-form `process.env['NEXT_PUBLIC_GLITCHTIP_DSN']` too; a build on 2026-11-11 confirmed it, so the bracket
  form was not a third gap.) The file also exports `onRouterTransitionStart`, which the SDK asks for at build;
  with `tracesSampleRate: 0` it records nothing.
- One scrubbing policy (`scrubEvent` / `scrubBreadcrumb` in `src/lib/observability/sentry.ts`) for browser and
  server, built from allowlists so a field the SDK adds later is removed by default:
  - request: body, cookies, query string and env removed; headers keep only `User-Agent` (case-insensitive), so
    `Referer`, `Authorization`, `Cookie` and `X-Forwarded-For` go in any casing.
  - URLs everywhere (request URL, transaction, breadcrumb `url`/`from`/`to`, stack-frame paths, URLs in tags and
    exception text): query and fragment dropped; the segment after `/survey/` or `/api/survey/` (a capability
    token) and any other 32+ char base64url segment that is not a UUID become `[token]`. Record ids
    (cuid, UUID, `/operator/<site>/<userId>`) stay: they grant nothing on their own.
  - `user` reduced to `{ id }`; `extra` dropped (the SDK's `wrap()` puts call arguments there); `contexts` keep
    only `browser`, `os`, `device`; stack-frame `vars` dropped.
  - breadcrumbs: `ui.*` dropped (a keypad tap records the tapped element, i.e. the PIN digits in order) and
    `console` dropped (log lines can carry names); the rest lose `message` and keep only `method`, `status_code`,
    `url`, `from`, `to`.
  - free text (exception values, event message, tag values, number-typed tags): best-effort, in this order —
    tokens first (URLs, then any bare 32+ char base64url word with a digit and a letter, UUIDs excepted), then
    email-like strings on the whole text (so an address containing a UUID is still masked), then 4–6 digit runs
    in any script (`\p{Nd}`) bounded only by non-digits, so `pin1234` and `x1234y` are masked too. UUIDs are set
    aside for the digit step and stay readable; haul numbers (`H-145388`) are masked like any digit run. Order
    matters: masking digits first would cut a token below 32 chars and leak the rest. Names in free text are NOT
    detected (tested as a residual), nor is a bare random token with no digit (~0.4% of tokens).
  - `sendDefaultPii: false`.
- The `has_pin` tag check that §2 described is REMOVED: nothing in the app ever set that tag, so the drop never
  fired. PIN safety rests on the structural rules above, not on a tag.
- Browser volume cap: at most 10 events per minute per tab (sliding window); the rest are dropped and counted, and
  the count rides the next accepted event as tag `dropped_by_limit`. `sampleRate: 1`; the SDK's default Dedupe
  integration drops identical consecutive events. A reload starts a fresh window, so a GlitchTip project rate
  limit is the backstop (to be set by fleet observability, not by this repo).
- Proof is in the build output: `npm run check:browser-dsn -- --expect errors.barnardhq.com` after a DSN build,
  `--expect-none` after a plain build. Both also fail if the WireGuard-private host appears in any browser chunk.
  CI builds with a synthetic DSN (`https://testkey@errors.barnardhq.com/26`) and runs the `--expect` check.

**Not verified by this amendment:** arrival of a real browser event in GlitchTip project 26. That needs the CHAD
value, a deploy, and a synthetic browser error (OPEN-ITEMS 0.HF HF-8).

**Residual:** free text is only regex-scrubbed (digit runs, emails, URLs); a name inside a thrown message
survives, so code must not put names or PINs into thrown messages (CLAUDE.md hard rule #8). Source-map upload (`GLITCHTIP_AUTH_TOKEN`) is
build-time too and is still not passed as a build arg, so browser stack traces stay minified.

## References

- ADR-0001 (Tech stack — observability mentioned as fleet-standard)
- ADR-0002 (CHAD-HQ host — shares fleet observability infrastructure)
- `docs/COMPLIANCE.md` (alert routing matrix — ntfy vs in-app)
- `docs/operator/fleet-observability-setup.md` (operator setup runbook)
- FLEET-PRIMER (in transcripts — fleet conventions)
- GlitchTip docs: https://glitchtip.com/documentation
- Next.js `instrumentation-client`: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
- OpenTelemetry Next.js: https://opentelemetry.io/docs/instrumentation/js/getting-started/nodejs/
