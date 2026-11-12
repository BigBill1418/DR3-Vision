// ADR-0078 G8c — where an operator lands after signing back in mid-task.
//
// The session-expired badge sends them to the name picker with `?next=<here>`
// so that after the PIN they resume on the screen they were already on. Without
// it they land on the hub and navigate back by hand, and that friction is what
// makes a recovery affordance read as still-broken.
//
// The parameter is attacker-influenceable — it arrives in a URL — so it is
// VALIDATED rather than trusted. Nothing here interpolates it into a page; it is
// handed to `router.push`, and an unvalidated push target is an open redirect.

/**
 * Resolve a post-PIN destination.
 *
 * Accepts only a same-origin path under this site's own operator surface;
 * anything else falls back to the hub. Rejects:
 *   - absolute URLs and scheme-relative `//evil.example` (open redirect)
 *   - paths for a DIFFERENT site (an operator is scoped to one site, and a
 *     cross-site landing would be a confusing dead end at best)
 *   - the pre-auth trio itself, which would bounce them straight back out
 */
export function resolveFloorReturnPath(next: string | null | undefined, siteCode: string): string {
  const hub = `/operator/${siteCode}/today`;
  if (!next) return hub;
  // `//host` is protocol-relative and navigates OFF-SITE despite starting with a
  // slash — the classic open-redirect bypass of a naive `startsWith('/')` check.
  if (!next.startsWith('/') || next.startsWith('//')) return hub;
  if (next.includes('\\')) return hub;

  const prefix = `/operator/${siteCode}/`;
  if (!next.startsWith(prefix)) return hub;

  // The pre-PIN surfaces: returning to one of these after signing in would land
  // the operator back at a sign-in screen.
  const leaf = next.slice(prefix.length).split('/')[0] ?? '';
  if (leaf === '') return hub;

  return next;
}

/**
 * ADR-0144 — the floor's sign-in URL, carrying the way back.
 *
 * The name picker is the floor's only sign-in, and it threads `?next=` through
 * to the keypad, which resolves it with `resolveFloorReturnPath`. This builds the
 * other end of that pipe for every signed-out surface: the check-in rows, the
 * write-refusal notice and the floor pages' own 401 redirects.
 *
 * `here` is validated with the SAME function the keypad uses, and a path it would
 * refuse is dropped rather than encoded — so this never emits a `next` the keypad
 * would bounce, and is not a way to smuggle an off-site target into a link.
 *
 * Pure and client-safe on purpose: `auth-helpers.ts` re-exports it for the server
 * pages, but importing that module from a `'use client'` row would drag the
 * Auth.js server code into the browser bundle.
 */
export function floorSignInPath(siteCode: string, here: string | null | undefined): string {
  const picker = `/operator/${encodeURIComponent(siteCode)}`;
  if (!here || resolveFloorReturnPath(here, siteCode) !== here) return picker;
  return `${picker}?next=${encodeURIComponent(here)}`;
}
