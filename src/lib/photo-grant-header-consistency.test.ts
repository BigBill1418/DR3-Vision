// ADR-0086 — the grant header name is a WIRE CONTRACT spelled in three places,
// and two of them cannot import the constant. This test is the seam.
//
// `PHOTO_GRANT_HEADER` lives in `@/lib/photo-grant`, which imports `node:crypto`.
// Two call sites therefore have to hard-code the literal instead:
//
//   - `src/middleware.ts` runs on the EDGE runtime, where `node:crypto` is
//     unavailable — importing the constant fails the build. (Same reason the
//     middleware imports `auth.config` rather than `auth`.)
//   - `src/lib/offline-queue.ts` is a `'use client'` module; importing it would
//     pull `node:crypto` into the browser bundle.
//
// So the duplication is forced, not lazy. What makes it dangerous is the failure
// SHAPE: rename the constant and the routes would read a header the middleware
// never admits and the iPad never sends — the feature goes inert, on the floor,
// while the whole suite stays green, because every other test builds its request
// from whichever spelling its own module uses. That is precisely the class
// ADR-0086 §10.2 already records once (a mechanism that stopped connecting while
// both ends kept passing).
//
// A source scan is the honest tool here, matching the repo's existing precedent
// (`money-minting.test.ts`, `close-authority.test.ts`). Reading the modules would
// prove nothing: `offline-queue.ts` only spells the header inside a function the
// test would have to drive, and the middleware's copy sits behind an auth branch.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PHOTO_GRANT_HEADER } from './photo-grant';

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

describe('ADR-0086 — every hard-coded copy of the grant header matches the constant', () => {
  // FALSIFIED BY HAND: changing `PHOTO_GRANT_HEADER` to `'x-photo-grant'` reds
  // both cases below naming the file that would have kept sending the old name.
  it('the middleware reads the same header the routes verify', () => {
    const src = read('../middleware.ts');
    expect(
      src.includes(`req.headers.get('${PHOTO_GRANT_HEADER}')`),
      `src/middleware.ts does not read '${PHOTO_GRANT_HEADER}' — a grant-bearing request ` +
        'would be 401d at the edge and the route would never run',
    ).toBe(true);
  });

  it('the offline queue SENDS the same header', () => {
    const src = read('./offline-queue.ts');
    // Case-insensitive: HTTP header names are case-insensitive on the wire and
    // the queue spells it `X-Upload-Grant` for readability. The SPELLING may
    // differ in case; the NAME may not.
    const sent = [...src.matchAll(/'([A-Za-z-]*[Uu]pload-[Gg]rant)'/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(sent.length, 'the queue no longer sends a grant header at all').toBeGreaterThan(0);
    for (const name of sent) {
      expect(
        name,
        `src/lib/offline-queue.ts sends '${name}' but the routes verify ` +
          `'${PHOTO_GRANT_HEADER}' — every queued photo would drain by session only`,
      ).toBe(PHOTO_GRANT_HEADER);
    }
  });

  it('the constant is lowercase, so `Headers.get` matching is unambiguous', () => {
    expect(PHOTO_GRANT_HEADER).toBe(PHOTO_GRANT_HEADER.toLowerCase());
  });
});
