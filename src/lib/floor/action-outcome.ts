// ADR-0144 — what a failed floor check-in tells the operator, by cause.
//
// On 2026-11-10 Woodland operators tapped Yes on a check-in and read "This card
// changed since the page loaded". The real cause was an expired session: the
// action threw `LoadAccessError(401)`, production Next replaced the error with an
// opaque digest, and the client printed the 409 copy for every failure. Telling
// someone to refresh when what they need is their PIN is a dead end with a
// confident sentence on it.
//
// So the two check-in actions now RETURN their refusals (`CheckinRefusal`), and
// everything the client can receive — a returned refusal or a thrown error — is
// classified here, once, for both rows.

/** A refused check-in, returned (not thrown) by the check-in server actions. */
export interface CheckinRefusal {
  ok: false;
  status: number;
  reason: string;
}

export type FloorActionFailure =
  | 'signed_out'
  | 'card_changed'
  | 'not_allowed'
  | 'app_updated'
  | 'no_connection'
  | 'failed';

/**
 * The fetch failure messages of the three engines the floor can run. WebKit's
 * "Load failed" is the iPad one. Matched exactly: a `TypeError` is also what a
 * plain bug throws, and calling a bug "no connection" would send the operator to
 * check Wi-Fi that is fine.
 */
const NETWORK_MESSAGES = new Set([
  'Load failed',
  'Failed to fetch',
  'NetworkError when attempting to fetch resource.',
]);

function isRefusal(x: unknown): x is CheckinRefusal {
  return (
    !!x &&
    typeof x === 'object' &&
    (x as { ok?: unknown }).ok === false &&
    typeof (x as { status?: unknown }).status === 'number'
  );
}

/**
 * Classify a returned refusal or a thrown error.
 *
 * `card_changed` comes ONLY from a real 409 — the read-back or the day guard
 * disagreed with the row. Anything unrecognised is `failed`, never a guess.
 *
 * The stale-bundle case is matched by name and message rather than with Next's
 * `unstable_isUnrecognizedActionError`: that helper is `instanceof`-based and
 * unstable-prefixed, and this module must stay a pure function the tests can
 * table. The message is the one Next 15 throws from `server-action-reducer.js`
 * when a deploy has retired the action id this page was rendered with.
 */
export function classifyFloorActionFailure(x: unknown): FloorActionFailure {
  if (isRefusal(x)) {
    if (x.status === 401) return 'signed_out';
    if (x.status === 409) return 'card_changed';
    if (x.status === 403 || x.status === 404) return 'not_allowed';
    return 'failed';
  }
  if (!(x instanceof Error)) return 'failed';
  if (
    x.name === 'UnrecognizedActionError' ||
    /was not found on the server|Failed to find Server Action/.test(x.message)
  ) {
    return 'app_updated';
  }
  if (x instanceof TypeError && NETWORK_MESSAGES.has(x.message)) return 'no_connection';
  return 'failed';
}
