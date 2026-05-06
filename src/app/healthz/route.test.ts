// Healthz route tests.
//
// The body shape of /healthz is a load-bearing contract for the
// swarmpilot deployer's post-deploy gate (see
// noc-master/api/services/deployer-worker.js — DEFAULT_HEALTH_MATCH =
// `"status"\s*:\s*"(ok|healthy)"`). These tests guard the contract on
// both branches:
//
//   - healthy   → body contains `"status":"ok"`     (deployer regex matches)
//   - degraded  → body contains `"status":"degraded"` (deployer regex does
//                 NOT match → gate fails → rollback fires)
//
// If either assertion regresses, the deployer either hangs for 15 min on
// every deploy or silently green-lights a broken one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRawMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  },
}));

import { GET } from './route';

// The deployer regex, kept in lock-step with deployer-worker.js. If
// fleet ever loosens the contract, update both ends in the same change.
const DEPLOYER_HEALTH_MATCH = /"status"\s*:\s*"(ok|healthy)"/i;

describe('GET /healthz', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
  });

  it('returns 200 with status:"ok" when the db probe succeeds', async () => {
    queryRawMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['ok']).toBe(true);
    expect(body['db_ok']).toBe(true);
    expect(typeof body['version']).toBe('string');
    expect(typeof body['uptime_s']).toBe('number');
  });

  it('healthy body satisfies the swarmpilot deployer regex', async () => {
    queryRawMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = await GET();
    const text = await res.text();
    expect(DEPLOYER_HEALTH_MATCH.test(text)).toBe(true);
  });

  it('returns 503 with status:"degraded" when the db probe fails', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('connection refused'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('degraded');
    expect(body['ok']).toBe(false);
    expect(body['db_ok']).toBe(false);
  });

  it('degraded body does NOT satisfy the swarmpilot deployer regex', async () => {
    // This is the failure-mode contract: a degraded service must fail
    // the deploy gate so rollback fires, rather than slipping through
    // because some other token in the body happens to spell "ok".
    queryRawMock.mockRejectedValueOnce(new Error('connection refused'));
    const res = await GET();
    const text = await res.text();
    expect(DEPLOYER_HEALTH_MATCH.test(text)).toBe(false);
  });
});
