// T-109 — Prometheus /metrics endpoint (ADR-0022 §4).
//
// A single prom-client Registry with default labels { service: 'dr3-vision' },
// Node process default metrics, and the custom DR3-Vision metrics enumerated in
// ADR-0022 §4. Node-only: prom-client reads `process` internals and is never
// safe to import from edge or client code (see the route's `runtime = 'nodejs'`).
//
// Dev HMR re-evaluates modules; constructing a second Registry (or re-declaring
// the same metric on the default registry) would throw
// "A metric with the name ... has already been registered." To stay idempotent
// we cache the whole metrics bundle on a `globalThis` slot and reuse it across
// reloads, building it exactly once per process.

import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

interface MetricsBundle {
  registry: Registry;
  httpRequestsTotal: Counter<'route' | 'method' | 'status'>;
  httpRequestDuration: Histogram<'route' | 'method'>;
  mymrcScrapeSuccess: Counter<'site' | 'outcome'>;
  r2UploadSuccess: Counter<'kind' | 'outcome'>;
  offlineQueueDepth: Gauge<'site' | 'user_id'>;
  bonusPayPeriodsByState: Gauge<'site' | 'state'>;
  payrollDeliverySuccess: Counter<'outcome'>;
}

// Reuse one bundle across dev HMR reloads. A module-scoped const would be
// re-initialized on every reload; the global slot survives.
const GLOBAL_KEY = Symbol.for('dr3-vision.observability.metrics');
type GlobalWithMetrics = typeof globalThis & {
  [GLOBAL_KEY]?: MetricsBundle;
};

function buildBundle(): MetricsBundle {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'dr3-vision' });
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: 'dr3_vision_http_requests_total',
    help: 'Total HTTP requests by route, method, status',
    labelNames: ['route', 'method', 'status'],
    registers: [registry],
  });

  const httpRequestDuration = new Histogram({
    name: 'dr3_vision_http_request_duration_seconds',
    help: 'HTTP request duration by route',
    labelNames: ['route', 'method'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [registry],
  });

  const mymrcScrapeSuccess = new Counter({
    name: 'dr3_vision_mymrc_scrape_total',
    help: 'MyMRC scrape attempts by site and outcome',
    labelNames: ['site', 'outcome'],
    registers: [registry],
  });

  const r2UploadSuccess = new Counter({
    name: 'dr3_vision_r2_upload_total',
    help: 'R2 upload attempts by kind and outcome',
    labelNames: ['kind', 'outcome'],
    registers: [registry],
  });

  const offlineQueueDepth = new Gauge({
    name: 'dr3_vision_offline_queue_depth',
    help: 'Per-session offline queue depth (active operators)',
    labelNames: ['site', 'user_id'],
    registers: [registry],
  });

  const bonusPayPeriodsByState = new Gauge({
    name: 'dr3_vision_bonus_months_by_state',
    help: 'Bonus pay-period counts by state',
    labelNames: ['site', 'state'],
    registers: [registry],
  });

  const payrollDeliverySuccess = new Counter({
    name: 'dr3_vision_payroll_delivery_total',
    help: 'M365 mail-send attempts to payroll',
    labelNames: ['outcome'], // success | retry | failed
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDuration,
    mymrcScrapeSuccess,
    r2UploadSuccess,
    offlineQueueDepth,
    bonusPayPeriodsByState,
    payrollDeliverySuccess,
  };
}

const g = globalThis as GlobalWithMetrics;
const bundle: MetricsBundle = (g[GLOBAL_KEY] ??= buildBundle());

export const registry = bundle.registry;
export const httpRequestsTotal = bundle.httpRequestsTotal;
export const httpRequestDuration = bundle.httpRequestDuration;
export const mymrcScrapeSuccess = bundle.mymrcScrapeSuccess;
export const r2UploadSuccess = bundle.r2UploadSuccess;
export const offlineQueueDepth = bundle.offlineQueueDepth;
export const bonusPayPeriodsByState = bundle.bonusPayPeriodsByState;
export const payrollDeliverySuccess = bundle.payrollDeliverySuccess;

/**
 * Record one completed HTTP request. Increments the request counter and observes
 * the duration histogram with a consistent `{ route, method }` label set.
 *
 * Node-side callers only (route-handler wrappers / instrumentation) — never the
 * edge middleware, which cannot import prom-client (see ADR-0022 §4 "Middleware
 * integration" and T-121).
 */
export function recordHttpRequest(args: {
  route: string;
  method: string;
  status: number;
  durationSeconds: number;
}): void {
  const { route, method, status, durationSeconds } = args;
  httpRequestsTotal.inc({ route, method, status: String(status) });
  httpRequestDuration.observe({ route, method }, durationSeconds);
}
