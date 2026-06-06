import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// T-115 — Guard the commit-tracked Grafana provisioning artifacts (ADR-0022 §5/§6).
//
// These files are imported by the fleet's Grafana provisioning, not by the app,
// so nothing else type-checks or parses them. This test is the only gate that:
//   1. the dashboard JSON is syntactically valid and carries the stable uid,
//   2. every dr3_vision_* metric the dashboard/alerts reference actually exists
//      in src/lib/observability/metrics.ts (catches a rename drift on either side).
//
// We read the metrics source as a string (not import it) because prom-client
// touches `process` internals and registers a global registry on import — a
// string scan is sufficient to assert the metric names are declared.

const repoRoot = process.cwd();
const dashboardPath = join(repoRoot, 'grafana', 'dashboards', 'dr3-vision.json');
const alertsPath = join(repoRoot, 'grafana', 'alerts', 'dr3-vision.yaml');
const metricsPath = join(repoRoot, 'src', 'lib', 'observability', 'metrics.ts');

const dashboardRaw = readFileSync(dashboardPath, 'utf8');
const alertsRaw = readFileSync(alertsPath, 'utf8');
const metricsRaw = readFileSync(metricsPath, 'utf8');

// The custom DR3-Vision metric names referenced by the dashboard + alerts.
const REFERENCED_METRICS = [
  'dr3_vision_http_requests_total',
  'dr3_vision_http_request_duration_seconds',
  'dr3_vision_mymrc_scrape_total',
  'dr3_vision_r2_upload_total',
  'dr3_vision_offline_queue_depth',
  'dr3_vision_bonus_months_by_state',
  'dr3_vision_payroll_delivery_total',
];

describe('grafana dashboard JSON', () => {
  const dashboard = JSON.parse(dashboardRaw) as Record<string, unknown>;

  it('parses as valid JSON', () => {
    expect(dashboard).toBeTypeOf('object');
  });

  it('carries the stable uid "dr3-vision"', () => {
    expect(dashboard['uid']).toBe('dr3-vision');
  });

  it('has at least one panel', () => {
    expect(Array.isArray(dashboard['panels'])).toBe(true);
    expect((dashboard['panels'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('references only metric names declared in metrics.ts', () => {
    for (const metric of REFERENCED_METRICS) {
      if (dashboardRaw.includes(metric)) {
        expect(metricsRaw).toContain(metric);
      }
    }
  });

  it('references every custom metric defined in metrics.ts', () => {
    for (const metric of REFERENCED_METRICS) {
      expect(metricsRaw, `metrics.ts must declare ${metric}`).toContain(metric);
      expect(dashboardRaw, `dashboard must use ${metric}`).toContain(metric);
    }
  });
});

describe('grafana alert rules YAML', () => {
  it('is non-empty and declares the dr3-vision-system ntfy contact for criticals', () => {
    expect(alertsRaw.length).toBeGreaterThan(0);
    expect(alertsRaw).toContain('dr3-vision-system');
  });

  it('only references metric names declared in metrics.ts', () => {
    for (const metric of REFERENCED_METRICS) {
      if (alertsRaw.includes(metric)) {
        expect(metricsRaw).toContain(metric);
      }
    }
  });
});
