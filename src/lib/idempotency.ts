// ADR-0078 — exactly-once for floor writes.
//
// The floor iPad can submit the same write more than once for three ordinary
// reasons: the operator double-taps, the request is retried after a timeout, or
// an offline-queue entry replays a submission whose response was lost. Today all
// three land twice. This module makes them land once.
//
// ## The contract
//
// A caller passes a client-minted `key` (see `@/lib/ulid`) plus a `scope` and the
// request `payload`. The FIRST caller to present a key claims it, runs the
// business write, and stores the response. Every later caller presenting the
// same key gets that stored response back verbatim without the write running
// again — UNLESS the payload differs, which means the key was reused for a
// different request and is refused with 409 `idempotency_key_reused`.
//
// ## Why `tx` is required, not optional
//
// The claim row and the business write MUST commit or roll back together. If the
// claim were written in its own transaction, two failure modes open, and both are
// the kind this codebase has already been bitten by:
//
//   - claim commits, write fails  → the key is burned. The operator's retry is
//     answered with a stored success for a write that never happened, and a count
//     silently vanishes.
//   - write commits, claim fails  → the duplicate defence is simply absent, which
//     is where we are today.
//
// So `withIdempotency` takes an open `Prisma.TransactionClient` and the caller is
// responsible for doing its business write on that SAME client. This mirrors
// `mergeEquipment`, which re-reads inside its transaction for the same reason:
// a guard that reads or writes outside the transaction it is guarding is not a
// guard, it is a race with better manners.
//
// ## Concurrency
//
// The claim is `INSERT ... ON CONFLICT (key) DO NOTHING`. Postgres does not skip
// a conflicting row that is still UNCOMMITTED — it blocks until the holding
// transaction resolves, then does nothing if that transaction committed, or
// inserts if it aborted. That is precisely the serialisation a double-tap needs,
// and it is why the ON CONFLICT clause is load-bearing rather than decorative:
// the `idempotency.double-submit` test removes it and watches two rows appear.
//
// The follow-up `SELECT` relies on READ COMMITTED (Postgres's default, and
// Prisma's): each statement takes a fresh snapshot, so the blocked transaction
// CAN see the row the other one just committed. Do not raise the isolation level
// on these paths without revisiting this.
//
// ## Why a replay is pinned to its original actor
//
// A key is an opaque bearer string. If a replay returned the stored response to
// anyone who presented the key, guessing or capturing one would read back another
// operator's response body. So a replay must match on the actor AND the scope AND
// the payload hash; anything else is treated as reuse and refused. The keys are
// CSPRNG-derived precisely so they cannot be guessed, but "unguessable" is a
// probability and an owner check is a fact.

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/** The transaction client `withIdempotency` and its caller must share. */
export type IdempotencyTx = Prisma.TransactionClient;

/**
 * A key was presented a second time for a DIFFERENT request (different payload,
 * scope, or actor). Refused rather than guessed at: honouring it would either
 * replay the wrong response or run a write the caller did not think it was
 * making.
 *
 * Carries `status` + `reason` so `loadsErrorResponse` maps it without a special
 * case.
 */
export class IdempotencyKeyReusedError extends Error {
  readonly status = 409;
  readonly reason = 'idempotency_key_reused';
  constructor(message = 'idempotency key reused for a different request') {
    super(message);
    this.name = 'IdempotencyKeyReusedError';
  }
}

/**
 * A key's row exists but was never completed. Only reachable if a row was
 * committed without its response — which this module's single-transaction
 * contract makes impossible, so it means something ELSE wrote the table. Refused
 * loudly instead of being read as an empty success.
 */
export class IdempotencyKeyIncompleteError extends Error {
  readonly status = 409;
  readonly reason = 'idempotency_key_in_flight';
  constructor(message = 'idempotency key claimed but never completed') {
    super(message);
    this.name = 'IdempotencyKeyIncompleteError';
  }
}

export interface WithIdempotencyArgs {
  /**
   * The client-minted key. `null`/`undefined` means the caller opted out — the
   * business write runs exactly as it does today with no dedupe. Every live
   * floor path passes one; the escape hatch exists so a server-side or admin
   * caller is not forced to invent a key.
   */
  key: string | null | undefined;
  /** Write class, e.g. `operator.count.create`. Part of the replay identity. */
  scope: string;
  actorUserId: string | null;
  siteId: string | null;
  /** The request body. Hashed canonically; never stored in full. */
  payload: unknown;
  /** MUST be the same client the business write uses. See the header. */
  tx: IdempotencyTx;
  /** HTTP status to record for a fresh success. Defaults to 201. */
  statusCode?: number;
}

export interface IdempotencyOutcome<T> {
  /** True when this call returned a STORED response and ran no business write. */
  replayed: boolean;
  statusCode: number;
  body: T;
}

/**
 * Deterministic JSON: object keys sorted at every depth, so two structurally
 * equal payloads hash identically regardless of property order. `JSON.stringify`
 * alone preserves insertion order, which would make `{a:1,b:2}` and `{b:2,a:1}`
 * different requests and turn an ordinary retry into a spurious 409.
 *
 * `undefined` members are dropped (JSON has no undefined); Dates serialise via
 * `toJSON` to their ISO string, which is stable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) {
    if (src[k] === undefined) continue;
    out[k] = sortDeep(src[k]);
  }
  return out;
}

/** sha256 hex of the canonical form of `payload`. */
export function requestHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

type StoredRow = {
  scope: string;
  actor_user_id: string | null;
  request_hash: string;
  status_code: number | null;
  response_body: unknown;
};

/**
 * Run `fn` at most once per `key`.
 *
 * @param fn the business write. MUST use `args.tx`. Its return value is stored
 *           as the response body and must be JSON-serialisable.
 */
export async function withIdempotency<T>(
  args: WithIdempotencyArgs,
  fn: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const statusCode = args.statusCode ?? 201;

  // No key ⇒ no dedupe. Explicitly NOT an error: it is the pre-ADR-0078
  // behaviour, kept reachable so a caller without a key still works.
  if (args.key == null || args.key === '') {
    return { replayed: false, statusCode, body: await fn() };
  }

  const hash = requestHash(args.payload);

  // Claim. `$executeRaw` returns the number of rows actually inserted, so 1 =
  // we own this key, 0 = somebody already does.
  const claimed = await args.tx.$executeRaw`
    INSERT INTO "idempotency_keys"
      ("key", "scope", "actor_user_id", "site_id", "request_hash", "created_at")
    VALUES
      (${args.key}, ${args.scope}, ${args.actorUserId}, ${args.siteId}, ${hash}, CURRENT_TIMESTAMP)
    ON CONFLICT ("key") DO NOTHING
  `;

  if (claimed === 1) {
    const body = await fn();
    await args.tx.$executeRaw`
      UPDATE "idempotency_keys"
         SET "status_code" = ${statusCode},
             "response_body" = ${JSON.stringify(body ?? null)}::jsonb
       WHERE "key" = ${args.key}
    `;
    return { replayed: false, statusCode, body };
  }

  // Replay. Re-read the owning row and prove it is the SAME request by the same
  // actor before handing back its response.
  const rows = await args.tx.$queryRaw<StoredRow[]>`
    SELECT "scope", "actor_user_id", "request_hash", "status_code", "response_body"
      FROM "idempotency_keys"
     WHERE "key" = ${args.key}
  `;
  const stored = rows[0];
  if (!stored) {
    // The row vanished between the failed insert and this read — only the TTL
    // sweep deletes rows, and it never touches anything younger than 7 days.
    // Treat as reuse rather than silently re-running the write.
    throw new IdempotencyKeyReusedError('idempotency key row disappeared mid-request');
  }
  if (
    stored.request_hash !== hash ||
    stored.scope !== args.scope ||
    stored.actor_user_id !== args.actorUserId
  ) {
    throw new IdempotencyKeyReusedError();
  }
  if (stored.status_code == null) {
    throw new IdempotencyKeyIncompleteError();
  }
  return {
    replayed: true,
    statusCode: stored.status_code,
    body: stored.response_body as T,
  };
}
