// T-109 — Prometheus /metrics endpoint (ADR-0022 §4) contract.
//
// Exercises the REAL route handler and the REAL prom-client registry (no mocks —
// the metrics module is pure Node logic). Verifies:
//   - GET returns valid Prometheus exposition text (HELP/TYPE lines + the
//     `service="dr3-vision"` default label) with the prom-client content type
//   - a request carrying `cf-connecting-ip` (came through Cloudflare) gets 404,
//     so the public tunnel cannot read fleet metrics
//   - recordHttpRequest() increments the request counter (scrape, record,
//     scrape again, assert the parsed delta)

import { describe, it, expect } from 'vitest';
import { GET } from './route';
import { registry, recordHttpRequest } from '@/lib/observability/metrics';

/** Pull the current counter value for a fully-labelled series out of the text. */
function counterValue(text: string, name: string, labelMatch: string): number {
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.startsWith(name) && line.includes(labelMatch)) {
      const parts = line.trim().split(/\s+/);
      return Number(parts[parts.length - 1]);
    }
  }
  return 0;
}

describe('GET /metrics — exposition output', () => {
  it('returns valid Prometheus text with HELP/TYPE and the service label', async () => {
    const res = await GET(new Request('http://internal/metrics'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(registry.contentType);

    const body = await res.text();
    // Prometheus exposition format always carries HELP + TYPE comment lines.
    expect(body).toMatch(/^# HELP /m);
    expect(body).toMatch(/^# TYPE /m);
    // Default label is applied to every series.
    expect(body).toContain('service="dr3-vision"');
    // A known custom metric is present.
    expect(body).toContain('dr3_vision_http_requests_total');
  });
});

describe('GET /metrics — internal-only guard', () => {
  it('returns 404 when the request carries cf-connecting-ip', async () => {
    const res = await GET(
      new Request('http://internal/metrics', {
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('serves metrics when no cf-connecting-ip header is present', async () => {
    const res = await GET(new Request('http://internal/metrics'));
    expect(res.status).toBe(200);
  });
});

describe('recordHttpRequest', () => {
  it('increments dr3_vision_http_requests_total for the labelled series', async () => {
    const label = 'route="/test/t109",method="GET",status="200"';

    const before = counterValue(await registry.metrics(), 'dr3_vision_http_requests_total', label);

    recordHttpRequest({
      route: '/test/t109',
      method: 'GET',
      status: 200,
      durationSeconds: 0.123,
    });

    const after = counterValue(await registry.metrics(), 'dr3_vision_http_requests_total', label);

    expect(after).toBe(before + 1);
  });

  it('also observes the duration histogram for the route', async () => {
    recordHttpRequest({
      route: '/test/t109-hist',
      method: 'POST',
      status: 201,
      durationSeconds: 0.04,
    });
    const text = await registry.metrics();
    expect(text).toContain('dr3_vision_http_request_duration_seconds_count{');
    expect(text).toContain('route="/test/t109-hist"');
  });
});
