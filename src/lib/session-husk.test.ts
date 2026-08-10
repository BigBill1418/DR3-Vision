// The SESSION HUSK — what an expired operator session actually looks like to a
// guard, as opposed to what every guard in this repo assumes it looks like.
//
// ## Why this file exists
//
// On 2026-08-10 the Woodland floor tried its first-ever load rejection. The
// operator opened the reject stage, walked to the trailer, framed the
// contamination and shot it. iOS suspends the page while the camera sheet is
// up, so no authenticated request left the iPad for the duration — and the
// operator idle window is FIVE MINUTES (`IDLE_TIMEOUT_OPERATOR_S`). The mint
// that followed the shutter answered **403**, the client rendered
// "Retry rejection evidence · mint failed (403)", and no amount of retrying
// could ever clear it: a bare retry cannot fix an expired session.
//
// The 403 was not a rejection-specific rule. It came from the shape below.
//
// ## The shape
//
// `auth.config.ts`'s jwt callback answers idle expiry (and the ADR-0053 D2
// revocation kill-switch) with `return {} as typeof token` — an EMPTY token,
// not a null one. Auth.js treats that as a live session: `@auth/core`'s session
// action builds and returns a session whenever the jwt callback returns
// anything other than `null`
// (`node_modules/@auth/core/lib/actions/session.js` — `if (token !== null)`),
// and `next-auth`'s server-side wrapper then returns `{ user, ...session }`.
//
// What comes out the other end is a HUSK: a session object with a `user` object
// on it, and nothing inside the user. Truthy where a guard looks, empty where a
// guard needs it.
//
// That is invisible to two different tests written in good faith:
//
//   - `middleware.ts`'s `if (!req.auth)` — the husk is not falsy, so the edge
//     never answers the 401 that ADR-0078 G7 promises for `/api/*`.
//   - `load-photo-guard.ts`'s `if (!session?.user || …)` — the husk's `user` is
//     not falsy either, so the check falls through to
//     `undefined !== 'operator'` and throws 403 FORBIDDEN for what is really an
//     unauthenticated request.
//
// The rest of the codebase tests `!session?.user?.id` (see
// `auth-helpers.ts` — `requireOperatorForSite` and thirteen siblings) and
// answers 401. That predicate sees straight through the husk. The photo guard
// was the one that did not.
//
// These tests pin the husk itself, so the two guards downstream are being
// hardened against a shape that is proven rather than assumed.

import { describe, expect, it } from 'vitest';
import { authConfig } from './auth.config';

type Tok = Record<string, unknown>;

const NOW_S = Math.floor(Date.now() / 1000);

/** A live operator token, ~ what a PIN sign-in mints. */
function operatorToken(lastSeenAgoSeconds: number): Tok {
  return {
    sub: 'op-juan',
    name: 'Juan Perez',
    role: 'operator',
    primary_site_id: 'site-woodland',
    all_sites: false,
    is_super_admin: false,
    iat: NOW_S - 3600,
    last_seen_at: NOW_S - lastSeenAgoSeconds,
  };
}

/** Run the REAL jwt callback the way Auth.js runs it on a session READ. */
async function jwtPass(token: Tok): Promise<Tok | null> {
  const cb = authConfig.callbacks.jwt as (a: { token: Tok }) => Promise<Tok | null>;
  return cb({ token });
}

/**
 * Run the REAL session callback over the session object `@auth/core` builds
 * from a token: `{ user: { name, email, image }, expires }`. Reproduced
 * literally from `lib/actions/session.js` — the point is that the user object
 * exists before our callback ever sees it, which is what makes it truthy.
 */
async function sessionPass(token: Tok): Promise<{ user: Record<string, unknown> }> {
  // Double cast: Auth.js types this callback over `AdapterSession`/`JWT`, and
  // the whole point here is to hand it the LOOSER object `@auth/core` actually
  // builds at runtime. Narrowing to the declared type would defeat the test.
  const cb = authConfig.callbacks.session as unknown as (a: {
    session: { user: Record<string, unknown>; expires: string };
    token: Tok;
  }) => Promise<{ user: Record<string, unknown> }>;
  return cb({
    session: {
      user: { name: token['name'], email: token['email'], image: token['picture'] },
      expires: new Date(Date.now() + 60_000).toISOString(),
    },
    token,
  });
}

describe('the operator idle window empties the token rather than nulling it', () => {
  it('keeps a token that is inside the 5-minute window', async () => {
    const t = await jwtPass(operatorToken(60));
    expect(t?.['sub'], 'a live operator lost their session inside the idle window').toBe('op-juan');
    expect(t?.['role']).toBe('operator');
  });

  // The load-bearing fact. `{}` is not `null`, and Auth.js only declines to
  // build a session when the jwt callback returns `null`.
  it('returns an EMPTY OBJECT — not null — once the window has passed', async () => {
    const t = await jwtPass(operatorToken(5 * 60 + 1));
    expect(t, 'Auth.js only skips session-building on null; this must not be null').not.toBeNull();
    expect(t).toEqual({});
  });
});

describe('the husk: what a guard is handed after an operator idles out', () => {
  it('produces a session whose `user` is TRUTHY and whose id and role are undefined', async () => {
    const emptied = await jwtPass(operatorToken(5 * 60 + 1));
    const session = await sessionPass(emptied!);

    // Truthy — this is the whole defect.
    expect(session.user, 'the husk must have a truthy user, or there is no bug').toBeTruthy();
    expect(session.user['id']).toBeUndefined();
    expect(session.user['role']).toBeUndefined();
    expect(session.user['primary_site_id']).toBeUndefined();
  });

  // The two predicates, side by side, over the same object. This is the whole
  // argument for the fix in one assertion pair.
  it('defeats `!session.user` and is caught by `!session.user?.id`', async () => {
    const session = await sessionPass((await jwtPass(operatorToken(5 * 60 + 1)))!);

    expect(!session.user, '`!session.user` still sees a signed-in operator here').toBe(false);
    expect(!session.user['id'], '`!session.user?.id` must see through the husk').toBe(true);
  });

  // Guard-the-guard: if our own session callback ever stopped writing
  // `all_sites` / `is_super_admin` unconditionally, `user` could become `{}`
  // — still truthy in JS, but the test above would then be passing for a
  // reason that has nothing to do with what production does. Pin the fact that
  // the callback populates the object it is handed.
  it('the husk user is a populated object, not an accident of `{}` being truthy', async () => {
    const session = await sessionPass((await jwtPass(operatorToken(5 * 60 + 1)))!);
    expect(session.user['all_sites']).toBe(false);
    expect(session.user['is_super_admin']).toBe(false);
  });

  // A manager is NOT on the 5-minute clock (12h), so this is an operator-shaped
  // failure. Recorded so the timeout asymmetry is visible next to the husk.
  it('a manager token 6 minutes idle is untouched — the 5-minute clock is operators only', async () => {
    const t = await jwtPass({ ...operatorToken(6 * 60), role: 'manager' });
    expect(t?.['sub']).toBe('op-juan');
  });
});
