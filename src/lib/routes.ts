// Shared route constants + post-login target resolution.
//
// Dependency-free on purpose: this module is imported from the client
// login form, the edge middleware-adjacent surfaces, and server pages,
// so it must NOT pull in `auth`, `prisma`, `next/headers`, etc.
//
// Background (the bug this fixes): the post-login default landing — and
// several wrong-role guard redirects — sent the user to `/dashboard`,
// the Sprint-1 site picker that lists the two MyMRC facilities
// (Woodland / Eugene). Since Sprint 2 (ADR-0020, T-107) the real home
// is the role-aware Vision Dashboard at `/`, which itself routes
// operators → `/operator` and renders the manager/admin launcher. The
// site picker is still reachable as the "Operations Dashboard" tile;
// it is just no longer the default landing.

/** Authenticated home — the role-aware Vision Dashboard (ADR-0020, T-107). */
export const HOME_ROUTE = '/';

/** The Sprint-1 site picker (Woodland / Eugene). Still a tile target, never a default. */
export const SITE_PICKER_ROUTE = '/dashboard';

/**
 * Decide where to send a user after they authenticate.
 *
 * `next` is the deep-link the middleware stashes (`?next=<pathname>`)
 * when it bounces an unauthenticated request to `/login`. We honor it
 * so deep links survive the login round-trip — but only if it is a
 * safe, app-internal absolute path. Anything else (missing, external,
 * protocol-relative, or a bare reference back to `/login`) falls back
 * to {@link HOME_ROUTE}.
 *
 * The external-URL rejection is an open-redirect guard: `next` is
 * attacker-influencable (it rides in the query string), so a value
 * like `//evil.com` or `https://evil.com` must never become a
 * post-login redirect target.
 */
export function resolvePostLoginTarget(next: string | null | undefined): string {
  if (!isSafeInternalPath(next)) return HOME_ROUTE;
  // Don't bounce the user back to the login page (would loop / land nowhere useful).
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login/')) {
    return HOME_ROUTE;
  }
  return next;
}

/**
 * True only for an app-internal absolute path: starts with a single
 * `/`, is not protocol-relative (`//host`), and is not a backslash
 * variant (`/\host`) that some browsers normalize to a host change.
 */
export function isSafeInternalPath(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value[0] !== '/') return false; // must be absolute-internal
  if (value[1] === '/' || value[1] === '\\') return false; // protocol-relative / host-change
  return true;
}
