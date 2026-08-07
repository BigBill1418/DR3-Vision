// ADR-0078 Amendment 1 — the photo gate is SITE-scoped, and the site check is
// the ONLY thing still standing.
//
// This amendment deliberately REMOVES an authorization check (the load's
// assigned operator). That makes the remaining check load-bearing in a way it
// was not before: previously a cross-site photo was refused twice over, so a
// broken site check would have been masked by the owner check. It is now the
// single control, and Eugene/Woodland are separate MRC contracts in separate
// jurisdictions (CLAUDE.md hard rule #2) — a cross-site photo is a compliance
// problem, not a convenience one.
//
// So the falsification here is the important test in the whole amendment.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/prisma', () => ({ prisma: { inboundLoad: { findUnique } } }));

import { requireOperatorAtLoadSite } from './load-photo-guard';

const EUGENE = 'site-eugene';
const WOODLAND = 'site-woodland';

function signedInAs(userId: string, siteId: string, role = 'operator') {
  auth.mockResolvedValue({ user: { id: userId, role, primary_site_id: siteId } });
}
function loadAt(siteId: string, assignedTo: string | null) {
  findUnique.mockResolvedValue({ id: 'load-1', site_id: siteId, assigned_operator_id: assignedTo });
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ADR-0078 Am.1 — photo.cross-site-still-refused', () => {
  // ── THE FALSIFICATION ───────────────────────────────────────────────────
  //
  // FALSIFIED BY HAND: deleting the
  // `if (session.user.primary_site_id !== load.site_id)` block from
  // `load-photo-guard.ts` makes this return 200 instead of 403 — a Eugene
  // operator attaching evidence to a Woodland load, across two separate MRC
  // contracts and two jurisdictions. Recorded red:
  //
  //   AssertionError: a Eugene operator reached a Woodland load:
  //   expected 200 to be 403
  //
  // With the owner check gone this is the only control left, so it must be
  // proven rather than assumed.
  it('refuses a Eugene operator reaching a Woodland load', async () => {
    signedInAs('op-eugene', EUGENE);
    loadAt(WOODLAND, 'op-woodland');
    const status = await statusOf(requireOperatorAtLoadSite('load-1'));
    expect(status, 'a Eugene operator reached a Woodland load').toBe(403);
  });

  it('refuses cross-site even when the operator IS the assigned owner', async () => {
    // The owner check is gone, so "assigned to me" must not become a way
    // around the site boundary.
    signedInAs('op-x', EUGENE);
    loadAt(WOODLAND, 'op-x');
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(403);
  });
});

describe('ADR-0078 Am.1 — the gate that was intentionally loosened', () => {
  // The whole point of the amendment: this used to be 403 and is now allowed,
  // because a photo that cannot drain is evidence that dies on one iPad.
  it('ALLOWS a same-site operator who does not own the load', async () => {
    signedInAs('op-b', EUGENE);
    loadAt(EUGENE, 'op-a');
    const access = await requireOperatorAtLoadSite('load-1');
    expect(access.actorUserId).toBe('op-b');
    expect(access.loadOwnerUserId).toBe('op-a');
  });

  it('allows the assigned owner (the ordinary case still works)', async () => {
    signedInAs('op-a', EUGENE);
    loadAt(EUGENE, 'op-a');
    const access = await requireOperatorAtLoadSite('load-1');
    expect(access.actorUserId).toBe('op-a');
    expect(access.loadOwnerUserId).toBe('op-a');
  });

  it('allows an unassigned load at the same site', async () => {
    signedInAs('op-a', EUGENE);
    loadAt(EUGENE, null);
    const access = await requireOperatorAtLoadSite('load-1');
    expect(access.loadOwnerUserId).toBeNull();
  });

  // The two identities must never be conflated — stamping the load owner as the
  // uploader would write a claim that a person did something they did not do,
  // into an append-only table (CLAUDE.md hard rule #6).
  it('reports the ACTOR and the LOAD OWNER as separate fields', async () => {
    signedInAs('op-b', EUGENE);
    loadAt(EUGENE, 'op-a');
    const access = await requireOperatorAtLoadSite('load-1');
    expect(access.actorUserId).not.toBe(access.loadOwnerUserId);
    expect(access).toMatchObject({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-b',
      loadOwnerUserId: 'op-a',
    });
  });
});

describe('ADR-0078 Am.1 — the checks that did NOT change', () => {
  it('refuses a non-operator role', async () => {
    signedInAs('mgr-1', EUGENE, 'manager');
    loadAt(EUGENE, null);
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(403);
  });

  it('refuses when there is no session', async () => {
    auth.mockResolvedValue(null);
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(403);
  });

  it('404s a load that does not exist', async () => {
    signedInAs('op-a', EUGENE);
    findUnique.mockResolvedValue(null);
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(404);
  });

  // Guards the guard: if the mock ever stopped supplying `primary_site_id`, the
  // cross-site test above would pass for the boring reason (undefined !== site).
  it('the fixture really does supply a matching site on the allow path', async () => {
    signedInAs('op-a', EUGENE);
    loadAt(EUGENE, 'op-a');
    const session = await auth();
    expect(session.user.primary_site_id).toBe(EUGENE);
    await expect(requireOperatorAtLoadSite('load-1')).resolves.toBeTruthy();
  });
});
