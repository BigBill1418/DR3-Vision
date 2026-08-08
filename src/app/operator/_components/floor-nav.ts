// ADR-0065 — where "back" and "Log Out" go on each operator (iPad) screen.
//
// Pure + pathname-driven so it is unit-testable and identical on server and
// client. DESTINATIONS ARE EXPLICIT — never `router.back()`. The floor iPad has
// an offline queue and the workflow calls `revalidatePath` + `redirect`, so the
// history stack does not reliably describe where the operator came from;
// history-based back can strand an operator on a replayed or dead entry.
//
// The surface map:
//
//   /operator                      site picker   pre-auth  no back (top), no Log Out
//   /operator/<site>               name picker   pre-auth  back → /operator
//   /operator/<site>/<userId>      PIN keypad    pre-auth  back → name picker
//                                                          (this IS "Not you? Switch user")
//   /operator/<site>/today         hub (post-PIN home)     no back, Log Out
//   /operator/<site>/<anything>    working screen          back → today, Log Out
//
// Log Out is hidden on the pre-auth trio because there is no session to end
// there — showing it would be a dead control. It is present on every screen an
// operator can reach WITH a session, which is the part Bill asked for.

/** Second-level segments that are real working surfaces rather than a user id. */
// ADR-0074 added `hauls`. A working segment MISSING from this set is treated as a
// user id, so the screen resolves as a pre-PIN auth surface: black chrome, no back,
// no Log Out — a black page with no way out. Adding the route without adding the
// segment is the defect this comment exists to prevent.
const WORK_SEGMENTS = new Set([
  'today',
  'queue',
  'inbound',
  'count',
  'processed',
  'load',
  'hauls',
  'dropoff', // ADR-0085
]);

export interface FloorNav {
  /** Site code from the path, or null on `/operator` itself. */
  siteCode: string | null;
  /** Explicit back destination, or null when nothing sits above this screen. */
  backHref: string | null;
  /** Whether an authenticated operator can be here (drives the Log Out pill). */
  showLogOut: boolean;
  /**
   * Pre-PIN auth surface. ADR-0014 puts auth surfaces on BLACK and operator
   * working surfaces on the green palette; the shell reads this to paint.
   */
  isAuthSurface: boolean;
}

export function resolveFloorNav(pathname: string): FloorNav {
  const segments = pathname.split('/').filter(Boolean);
  const siteCode = segments[1] ?? null;

  // `/operator` — the site picker. Nothing above it, nobody signed in.
  if (siteCode === null) {
    return { siteCode: null, backHref: null, showLogOut: false, isAuthSurface: true };
  }

  const leaf = segments[2] ?? null;

  // `/operator/<site>` — the name picker.
  if (leaf === null) {
    return { siteCode, backHref: '/operator', showLogOut: false, isAuthSurface: true };
  }

  // `/operator/<site>/<userId>` — the PIN keypad. Anything at this depth that
  // isn't a known working segment is a user id.
  if (!WORK_SEGMENTS.has(leaf)) {
    return {
      siteCode,
      backHref: `/operator/${siteCode}`,
      showLogOut: false,
      isAuthSurface: true,
    };
  }

  // `/operator/<site>/today` — the post-PIN hub. It IS the back destination.
  if (leaf === 'today') {
    return { siteCode, backHref: null, showLogOut: true, isAuthSurface: false };
  }

  return {
    siteCode,
    backHref: `/operator/${siteCode}/today`,
    showLogOut: true,
    isAuthSurface: false,
  };
}
