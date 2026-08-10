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

  // CORRECTED 2026-08-10 — this used to assert 403 and that is the bug it was
  // agreeing with. "There is no session" is not "you are forbidden"; a sign-in
  // fixes it, and the whole ADR-0078 G7/G8c recovery affordance keys on 401.
  // See the `session husk` block below.
  it('answers 401 — not 403 — when there is no session', async () => {
    auth.mockResolvedValue(null);
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(401);
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-10 — the session HUSK, and the 403 that could never be retried away
// ─────────────────────────────────────────────────────────────────────────────
//
// ## What happened on the floor
//
// Woodland's first-ever load rejection. The operator opened the reject stage,
// picked a category, walked to the trailer and photographed the contamination.
// iOS suspends the page while the camera sheet is up; the operator idle window
// is FIVE MINUTES. The mint that followed the shutter answered **403** and the
// screen said "Retry rejection evidence · mint failed (403)" — over and over,
// because a retry cannot fix an expired session. The bytes were never queued
// and the load stranded at `unload_started` with no rejection evidence.
//
// It was not a rejection-specific rule: `kind='rejection'` had minted
// successfully through this exact route earlier the same morning. It was the
// predicate below.
//
// ## The shape
//
// Auth.js answers idle expiry (and the ADR-0053 D2 kill-switch) with an EMPTY
// token, not a null one, and `@auth/core` builds a session from anything that
// is not null. What reaches a guard is a HUSK: `session.user` is a truthy
// object with no `id` and no `role`. `session-husk.test.ts` proves that shape
// against the real callbacks; these tests pin what this guard must do with it.
//
// `!session?.user` is husk-blind, so the check fell through to
// `undefined !== 'operator'` and threw 403 — the one guard of fifteen in this
// codebase that collapsed "unauthenticated" into "forbidden". Every sibling
// (`requireOperatorForSite` in `auth-helpers.ts` and twelve others) tests
// `!session?.user?.id` and answers 401.
//
// The status is not cosmetic. `offline-queue.ts`'s `isAuthResponse` classifies
// 401 as `auth:` — a state the floor chrome renders as "sign in and this will
// send" — and deliberately excludes 403, which is authenticated-but-refused and
// parks as a conflict no sign-in can clear. A 403 here therefore pointed the
// operator at the one action that could not work.
//
// FALSIFIED BY HAND: restoring `if (!session?.user || session.user.role !== …)`
// reds every case in this block with `expected 403 to be 401`.

describe('an EXPIRED session is 401, not 403 (the 2026-08-10 rejection-evidence defect)', () => {
  /** Exactly what `session-husk.test.ts` proves Auth.js hands a guard. */
  function idledOut() {
    auth.mockResolvedValue({
      user: {
        name: undefined,
        email: undefined,
        image: undefined,
        all_sites: false,
        is_super_admin: false,
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  it('answers 401 for the husk an idled-out operator produces', async () => {
    idledOut();
    loadAt(WOODLAND, 'op-juan');
    const status = await statusOf(requireOperatorAtLoadSite('load-1'));
    expect(status, 'an expired session was called FORBIDDEN, which no sign-in clears').toBe(401);
  });

  // Guard-the-guard. If the fixture ever grew an `id`, the case above would go
  // green for the wrong reason — it would be asserting the ordinary allow path.
  it('the husk fixture really is truthy-but-empty', async () => {
    idledOut();
    const session = (await auth()) as { user: Record<string, unknown> };
    expect(session.user, 'a falsy user would make the whole block vacuous').toBeTruthy();
    expect(session.user['id']).toBeUndefined();
    expect(session.user['role']).toBeUndefined();
  });

  // The refusal must still be readable by the queue: `isAuthResponse` keys on
  // the STATUS, and the floor chrome's sign-in affordance keys on that.
  it('the 401 body names the condition rather than saying "forbidden"', async () => {
    idledOut();
    loadAt(WOODLAND, 'op-juan');
    try {
      await requireOperatorAtLoadSite('load-1');
      expect.unreachable('the husk was allowed through');
    } catch (e) {
      if (!(e instanceof Response)) throw e;
      expect(e.status).toBe(401);
      expect(await e.text()).toBe('unauthenticated');
    }
  });

  // ── What must NOT move ────────────────────────────────────────────────────
  //
  // Widening 403 → 401 for "no identity" must not soften either authorization
  // check. A signed-in person who is refused is still refused, and 401 would
  // invite the client to offer a sign-in that changes nothing.

  it('a REAL signed-in non-operator is still 403 — not downgraded to 401', async () => {
    signedInAs('mgr-1', WOODLAND, 'manager');
    loadAt(WOODLAND, null);
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(403);
  });

  it('a REAL cross-site operator is still 403 — the compliance boundary is untouched', async () => {
    signedInAs('op-eugene', EUGENE);
    loadAt(WOODLAND, 'op-woodland');
    expect(await statusOf(requireOperatorAtLoadSite('load-1'))).toBe(403);
  });

  // The load read must not happen for a request that carries no identity at
  // all: refusing before the query is both cheaper and the honest ordering.
  it('does not read the load at all for an identity-less request', async () => {
    idledOut();
    await statusOf(requireOperatorAtLoadSite('load-1'));
    expect(findUnique).not.toHaveBeenCalled();
  });
});
