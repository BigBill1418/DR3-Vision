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
