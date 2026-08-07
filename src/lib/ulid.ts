// ADR-0078 — the queue/idempotency id generator, extracted so the CLIENT that
// mints a key and the SERVER that validates one agree on the shape.
//
// This lived inside `offline-queue.ts` as a private `newId()` from T-009. It is
// pulled out here unchanged in behaviour because ADR-0078 gives the same string
// a second job: it is now the `Idempotency-Key` a floor write carries, so a
// double-tap, a retry and a queued replay all name the SAME write. A generator
// that only one module can reach cannot be that.
//
// NOT a spec ULID, and deliberately not: Crockford base32 with a monotonic
// counter would mean a new dependency, and CLAUDE.md hard rule / ADR-0012 §4
// holds the dep list closed for this surface. What the id actually has to do is
// (a) never collide and (b) sort lexicographically by mint time so the replay
// loop can preserve the operator's ORDER. A 48-bit millisecond timestamp in
// base36 plus 80 bits from the CSPRNG does both: two keys minted in the same
// millisecond collide with probability ~2^-80.
//
// Isomorphic on purpose — `globalThis.crypto.getRandomValues` is present in the
// browser and in Node ≥ 18 (webcrypto is global), so the same module serves the
// iPad, the route handlers and the tests. `Math.random()` is NOT an acceptable
// fallback here: a predictable key is a key another session could guess, and a
// guessed key reads back a stored response body (see `withIdempotency`, which
// also pins the reader to the original actor for exactly this reason).

/** Character length of every id this module mints. 13 + 1 + 20. */
export const QUEUE_ID_LENGTH = 34;

/**
 * A minted id: 13-char base36 millisecond timestamp, `-`, 20 chars of base36
 * randomness. Lexicographic order matches mint order for all dates this
 * software will ever see (13 base36 chars covers to the year 10889).
 */
const QUEUE_ID_RE = /^[0-9a-z]{13}-[0-9a-z]{20}$/;

export function newQueueId(): string {
  const ts = Date.now().toString(36).padStart(13, '0');
  const buf = new Uint8Array(10);
  globalThis.crypto.getRandomValues(buf);
  let rand = '';
  for (const b of buf) rand += b.toString(36).padStart(2, '0');
  return `${ts}-${rand}`;
}

/**
 * True when `value` is shaped like something {@link newQueueId} minted.
 *
 * Used by the server to reject a malformed `Idempotency-Key` BEFORE it reaches
 * the keys table. This is a shape check, not an authenticity check — a caller
 * can still mint a well-formed key for itself, which is the point. Authenticity
 * is enforced separately by pinning a replay to the actor that first claimed the
 * key.
 */
export function isQueueId(value: unknown): value is string {
  return typeof value === 'string' && value.length === QUEUE_ID_LENGTH && QUEUE_ID_RE.test(value);
}
