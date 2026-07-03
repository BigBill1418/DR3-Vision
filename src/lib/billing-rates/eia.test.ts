// ADR-0040 D4 — EIA fetch tests. Fully injected `fetchImpl` + `apiKey` (no network).
// Covers: fail-open on missing key, HTTP error, malformed payload, and the happy
// path parsing the v2 `response.data` array into normalized weekly points.

import { describe, it, expect } from 'vitest';
import { fetchEiaWeeklyDiesel, EIA_V2_DIESEL_URL, EIA_DIESEL_FACETS } from './eia';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchEiaWeeklyDiesel — fail-open', () => {
  it('returns no_api_key (does not throw) when the key is absent', async () => {
    const r = await fetchEiaWeeklyDiesel({ apiKey: '', fetchImpl: async () => new Response('') });
    expect(r).toEqual({ ok: false, reason: 'no_api_key', detail: expect.any(String) });
  });

  it('returns http_error on a non-2xx response', async () => {
    const r = await fetchEiaWeeklyDiesel({
      apiKey: 'k',
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('http_error');
  });

  it('returns network_error when fetch throws', async () => {
    const r = await fetchEiaWeeklyDiesel({
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network_error');
  });

  it('returns bad_payload when response.data is missing', async () => {
    const r = await fetchEiaWeeklyDiesel({ apiKey: 'k', fetchImpl: async () => jsonResponse({ response: {} }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_payload');
  });
});

describe('fetchEiaWeeklyDiesel — happy path', () => {
  it('parses v2 response.data into normalized weekly points', async () => {
    let calledUrl = '';
    const r = await fetchEiaWeeklyDiesel({
      apiKey: 'secret-key',
      length: 2,
      fetchImpl: async (input) => {
        calledUrl = String(input);
        return jsonResponse({
          response: {
            data: [
              { period: '2026-06-29', value: 5.85, units: 'DPGAL' },
              { period: '2026-06-22', value: '5.42', units: 'DPGAL' }, // string value tolerated
            ],
          },
        });
      },
    });
    expect(r).toEqual({
      ok: true,
      prices: [
        { weekOf: '2026-06-29', usdPerGal: 5.85 },
        { weekOf: '2026-06-22', usdPerGal: 5.42 },
      ],
    });
    // The request targets the documented v2 route with the diesel facets + key.
    expect(calledUrl.startsWith(EIA_V2_DIESEL_URL)).toBe(true);
    expect(calledUrl).toContain(`facets%5Bproduct%5D%5B%5D=${EIA_DIESEL_FACETS.product}`);
    expect(calledUrl).toContain(`facets%5Bduoarea%5D%5B%5D=${EIA_DIESEL_FACETS.duoarea}`);
    expect(calledUrl).toContain('api_key=secret-key');
  });

  it('skips unusable rows and fails if none remain', async () => {
    const r = await fetchEiaWeeklyDiesel({
      apiKey: 'k',
      fetchImpl: async () =>
        jsonResponse({ response: { data: [{ period: null, value: 'x' }, { period: '2026', value: null }] } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_payload');
  });
});
