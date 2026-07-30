// ADR-0066 §1.5 — internal AP escalation-scan route guard tests (mirrors the AP
// expiry route test): cf-connecting-ip → 404, loopback → 200 + summary, optional
// bearer. Plus the posture that matters here — a FAILING scan must not become a
// clean 200.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runApEscalationScan = vi.fn(async () => ({
  scanned: 2,
  escalated: 1,
  requestIds: ['req-1'],
  problems: [],
}));

vi.mock('@/lib/ap/escalation-scan', () => ({
  runApEscalationScan: () => runApEscalationScan(),
}));
// ADR-0068 (Amendment 2) — reimbursements ride the same hourly tick. Mocked here
// so these tests keep testing the AP route CONTRACT rather than the reimbursement
// scan; its own behaviour is covered in reimbursements/__tests__/escalation.test.ts.
const runReimbursementEscalationScan = vi.fn(async () => ({
  scanned: 0,
  escalated: 0,
  requestIds: [] as string[],
  problems: [] as string[],
}));
vi.mock('@/lib/reimbursements/escalation', () => ({
  runReimbursementEscalationScan: () => runReimbursementEscalationScan(),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/ap/escalation-scan', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runApEscalationScan.mockReset();
  runApEscalationScan.mockResolvedValue({
    scanned: 2,
    escalated: 1,
    requestIds: ['req-1'],
    problems: [],
  });
  runReimbursementEscalationScan.mockReset();
  runReimbursementEscalationScan.mockResolvedValue({
    scanned: 0,
    escalated: 0,
    requestIds: [],
    problems: [],
  });
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/ap/escalation-scan', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without scanning', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runApEscalationScan).not.toHaveBeenCalled();
  });

  it('runs the scan and returns the summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 2, escalated: 1, requestIds: ['req-1'] });
    expect(runApEscalationScan).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });

  it('propagates a scan failure instead of returning a clean 200', async () => {
    // The whole point of §B.8: a broken scan that answered 200 would be
    // indistinguishable from a healthy empty backlog — the outage's exact shape.
    runApEscalationScan.mockRejectedValue(new Error('connection terminated'));
    await expect(POST(req())).rejects.toThrow(/connection terminated/);
  });
});

// ── ADR-0068 (Amendment 2) — the reimbursement pass rides this tick ──────────

describe('reimbursement escalation on the same tick', () => {
  it('reports the reimbursement summary alongside the AP one', async () => {
    runReimbursementEscalationScan.mockResolvedValue({
      scanned: 3,
      escalated: 1,
      requestIds: ['rb-1'],
      problems: [],
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { escalated: number; reimbursements: { escalated: number } };
    // BOTH results present — a tick that silently dropped one would be the
    // half-ran-and-looked-fine shape this ADR series exists to remove.
    expect(body.escalated).toBe(1);
    expect(body.reimbursements.escalated).toBe(1);
  });

  it('does NOT discard the AP result when the reimbursement scan throws', async () => {
    runReimbursementEscalationScan.mockRejectedValue(new Error('reimbursement boom'));
    const res = await POST(req());
    // Non-200 so the daemon logs it — but the AP work it already earned is still
    // in the body rather than being thrown away.
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      escalated: number;
      reimbursementError: string;
      reimbursements: unknown;
    };
    expect(body.escalated).toBe(1);
    expect(body.reimbursements).toBeNull();
    expect(body.reimbursementError).toContain('reimbursement boom');
  });
});
