// ADR-0067 §3.2 / §A.9 — the change-notification endpoint.
//
// This is the ONE route in the repo that cannot be loopback-gated (Graph has to
// reach it), so the tests here are about the boundary: the validation handshake
// answers correctly and safely, and an unverifiable notification is dropped
// rather than trusted.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above every top-level binding, so the spies
// they close over must be created inside `vi.hoisted` or they are still in the
// temporal dead zone when the factory runs.
const { sweepMock, verifyMock, recordMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(async () => ({ status: 'ok' })),
  verifyMock: vi.fn(),
  recordMock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/doc-ingest/sweep', () => ({ runDocIngestSweep: sweepMock }));
vi.mock('@/lib/doc-ingest/subscriptions', () => ({
  verifyNotification: verifyMock,
  recordNotificationDelivery: recordMock,
}));

import { POST } from '@/app/api/doc-ingest/notifications/route';

const URL_BASE = 'https://dr3-vision.svdp.us/api/doc-ingest/notifications';

beforeEach(() => {
  sweepMock.mockClear();
  verifyMock.mockReset();
  recordMock.mockClear();
});

function notificationRequest(body: unknown): Request {
  return new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the Graph validation handshake', () => {
  it('echoes the validationToken verbatim as text/plain', async () => {
    const res = await POST(new Request(`${URL_BASE}?validationToken=abc123`, { method: 'POST' }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
    // Reflected, attacker-controlled text — it must never be interpretable as
    // markup, and it must not be sniffed into something else.
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers the handshake WITHOUT requiring a clientState', async () => {
    // It cannot carry one — the subscription does not exist yet. This is per the
    // protocol, and asserting it stops someone "hardening" it into a breakage.
    const res = await POST(new Request(`${URL_BASE}?validationToken=xyz`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('refuses an absurdly long token instead of reflecting it', async () => {
    const huge = 'a'.repeat(5000);
    const res = await POST(new Request(`${URL_BASE}?validationToken=${huge}`, { method: 'POST' }));
    expect(res.status).toBe(400);
  });
});

describe('inbound notifications', () => {
  it('verifies clientState and kicks a delta sweep for the affected drive', async () => {
    verifyMock.mockResolvedValue({ id: 'sub-row-1', drive_id: 'drive-A' });

    const res = await POST(
      notificationRequest({
        value: [
          {
            subscriptionId: 'graph-sub-1',
            clientState: 'secret',
            resource: '/drives/drive-A/root',
          },
        ],
      }),
    );

    expect(res.status).toBe(202);
    expect(verifyMock).toHaveBeenCalledWith({}, 'graph-sub-1', 'secret');
    expect(recordMock).toHaveBeenCalled();
    // A notification says only THAT something changed — the delta says what.
    expect(sweepMock).toHaveBeenCalledTimes(1);
    // The spy is declared with no parameters (the route's call shape is not the
    // thing under test), so the recorded args are read back through one narrow
    // cast rather than by widening the mock's signature.
    const [, options] = sweepMock.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(options).toMatchObject({ trigger: 'notification', driveId: 'drive-A' });
  });

  it('DROPS a notification whose clientState does not verify — and sweeps nothing', async () => {
    verifyMock.mockResolvedValue(null);

    const res = await POST(
      notificationRequest({ value: [{ subscriptionId: 'graph-sub-1', clientState: 'forged' }] }),
    );

    // Unverifiable is indistinguishable from forged. Dropping is safe precisely
    // because the scheduled sweep is the correctness path.
    expect(sweepMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    // 202 regardless: Graph deactivates a subscription that returns errors, and
    // an unauthenticated caller learns nothing from the response either way.
    expect(res.status).toBe(202);
  });

  it('drops a notification with no subscriptionId at all', async () => {
    const res = await POST(notificationRequest({ value: [{ clientState: 'secret' }] }));
    expect(res.status).toBe(202);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('sweeps each affected drive ONCE even when a batch names it repeatedly', async () => {
    verifyMock.mockResolvedValue({ id: 'sub-row-1', drive_id: 'drive-A' });
    await POST(
      notificationRequest({
        value: [
          { subscriptionId: 'graph-sub-1', clientState: 's' },
          { subscriptionId: 'graph-sub-1', clientState: 's' },
          { subscriptionId: 'graph-sub-1', clientState: 's' },
        ],
      }),
    );
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed body', async () => {
    const bad = new Request(URL_BASE, { method: 'POST', body: 'not json' });
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(notificationRequest({ nope: true }))).status).toBe(400);
  });
});
