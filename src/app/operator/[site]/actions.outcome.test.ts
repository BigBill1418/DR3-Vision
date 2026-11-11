// ADR-0144 — the two check-in actions RETURN their refusals.
//
// Next.js replaces a thrown server-action error with an opaque digest in
// production, so the client could not tell "your session ended" (401) from "the
// card changed" (409) and printed the 409 copy for both. On 2026-11-10 that sent
// Woodland operators to refresh a page whose real problem was the 5-minute idle
// timeout. These tests pin the server half: the refusal arrives as a value the
// client can read, the success path still redirects, and nothing about the
// server checks or the write moved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isNextRedirectSignal } from '@/lib/next-redirect';

const auth = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => auth(), signOut: vi.fn() }));
const findSite = vi.fn();
vi.mock('@/lib/prisma', () => ({ prisma: { site: { findUnique: (a: unknown) => findSite(a) } } }));
const startInboundLoad = vi.fn();
vi.mock('@/lib/load-service', async (orig) => ({
  ...(await orig<typeof import('@/lib/load-service')>()),
  startInboundLoad: (a: unknown) => startInboundLoad(a),
}));
vi.mock('@/lib/loads/load-claim', () => ({ takeOverLoad: vi.fn(), readClaimHolder: vi.fn() }));
const assertUiSurfaceActivated = vi.fn();
vi.mock('@/lib/loads/record-guards', async (orig) => ({
  ...(await orig<typeof import('@/lib/loads/record-guards')>()),
  assertUiSurfaceActivated: (...a: unknown[]) => assertUiSurfaceActivated(...a),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: `NEXT_REDIRECT;replace;${url};307;`,
    });
  },
}));

import { LoadAccessError } from '@/lib/load-service';
import { LoadsInventoryNotActivatedError } from '@/lib/loads/record-guards';
import { startLoadAction, startLoadReconciledAction } from './actions';

const OPERATOR = { user: { id: 'op-1', role: 'operator', primary_site_id: 'site-w' } };
/** `src/lib/session-husk.test.ts` — an idled-out session: a user with nothing in it. */
const HUSK = { user: {} };

const start = () => startLoadAction('woodland', 'exp-1', 'H-1');
const reconcile = () => startLoadReconciledAction('woodland', 'exp-1', '2026-11-09', 'H-1');

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(OPERATOR);
  findSite.mockResolvedValue({ id: 'site-w', code: 'woodland' });
  assertUiSurfaceActivated.mockResolvedValue(undefined);
  startInboundLoad.mockResolvedValue({ id: 'load-9', claimed: true });
});

describe.each([
  ['startLoadAction', start],
  ['startLoadReconciledAction', reconcile],
])('ADR-0144 — %s', (_name, call) => {
  it('THE INCIDENT: an expired session RETURNS 401 instead of throwing', async () => {
    auth.mockResolvedValue(HUSK);
    await expect(call()).resolves.toEqual({
      ok: false,
      status: 401,
      reason: 'not_authenticated_as_operator',
    });
    expect(startInboundLoad).not.toHaveBeenCalled();
  });

  it('a real card change RETURNS 409 with its reason', async () => {
    startInboundLoad.mockRejectedValue(new LoadAccessError(409, 'haul_number_mismatch'));
    await expect(call()).resolves.toEqual({
      ok: false,
      status: 409,
      reason: 'haul_number_mismatch',
    });
  });

  it('a non-operator and a wrong-site operator RETURN 403', async () => {
    auth.mockResolvedValue({ user: { id: 'm-1', role: 'manager' } });
    await expect(call()).resolves.toMatchObject({ ok: false, status: 403 });
    auth.mockResolvedValue({ user: { ...OPERATOR.user, primary_site_id: 'site-e' } });
    await expect(call()).resolves.toMatchObject({
      ok: false,
      status: 403,
      reason: 'operator_not_assigned_to_site',
    });
    expect(startInboundLoad).not.toHaveBeenCalled();
  });

  it('a surface not yet live for this site RETURNS 403, and writes nothing', async () => {
    assertUiSurfaceActivated.mockRejectedValue(new LoadsInventoryNotActivatedError());
    await expect(call()).resolves.toEqual({
      ok: false,
      status: 403,
      reason: 'surface_not_activated',
    });
    expect(startInboundLoad).not.toHaveBeenCalled();
  });

  it('success still REDIRECTS to the load (NEXT_REDIRECT propagates)', async () => {
    const e = await call().then(
      () => null,
      (err: unknown) => err,
    );
    expect(isNextRedirectSignal(e)).toBe(true);
    expect((e as { digest: string }).digest).toContain('/operator/woodland/load/load-9');
  });

  it('an unexpected failure is NOT converted — it still throws', async () => {
    startInboundLoad.mockRejectedValue(new Error('db down'));
    await expect(call()).rejects.toThrow('db down');
  });
});

it('the write arguments are unchanged — the haul and day still travel to the server check', async () => {
  await reconcile().catch(() => undefined);
  expect(startInboundLoad).toHaveBeenCalledWith({
    expectedLoadId: 'exp-1',
    siteId: 'site-w',
    operatorUserId: 'op-1',
    acknowledgedHaulId: 'H-1',
    reconcile: { acknowledgedSlotDayISO: '2026-11-09' },
  });
});
