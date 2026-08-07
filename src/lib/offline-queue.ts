'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { newQueueId } from '@/lib/ulid';

// IndexedDB-backed offline queue for the operator iPad. Per CLAUDE.md
// hard rule #9 IndexedDB + Service Worker cache are the only persistence
// paths in the PWA shell — no localStorage, no sessionStorage. ADR-0006
// codifies the queue strategy; T-009 implements it; ADR-0078 makes it
// honest.
//
// Two stores:
//   - `pending_uploads`  — photo blobs awaiting R2 PUT + /api/photos/confirm.
//   - `pending_actions`  — operator writes that did not reach the server.
//                          Replayed through /api/queue/replay.
//
// ── What ADR-0078 changed and why ────────────────────────────────────────
//
// The action queue shipped INERT. `enqueueAction` had no callers, and
// `replayAll` POSTed to `/api/queue/replay`, which did not exist. Next
// answered 404, the hard-4xx branch below classified that as a conflict, and
// conflicts are never retried — so any action that had ever been queued would
// have been stuck permanently, on the first attempt, with nothing surfacing it.
// The endpoint now exists, the write paths now enqueue, and conflicts now have
// a screen.
//
// Each action row carries the four things a replay cannot safely infer later:
//
//   `scope`            — which write this is, from a server-side ALLOWLIST.
//                        The queue never names a function; it names a class of
//                        write the server already knows how to gate.
//   `idempotency_key`  — minted ONCE, when the operator acted. It is the same
//                        key the live attempt used, so if that attempt actually
//                        landed and only its response was lost, the replay
//                        returns the original response and writes nothing.
//   `target_day`       — the Pacific day the entry was FOR. Checked before
//                        dispatch. An entry for a day that is no longer today
//                        is REFUSED and held as a conflict — never retargeted
//                        (which would file a count against the wrong production
//                        day) and never dropped (which would lose the work).
//   `site_code`        — which site's rollout gate to evaluate. It selects a
//                        gate; it can never grant reach the session lacks.
//
// Replay preserves queued-at order and HALTS on the first conflict within a
// `load_id`. Replaying entry 3 of a load after entry 2 was refused would apply
// the operator's steps out of order against a state that never existed.

const DB_NAME = 'dr3-vision-queue';
// v2 — ADR-0078. v1 rows are preserved and flagged, never dropped; see `upgrade`.
const DB_VERSION = 2;
const UPLOADS = 'pending_uploads';
const ACTIONS = 'pending_actions';

/** Marks a row that needs a PERSON, not another retry. */
export const CONFLICT_PREFIX = 'conflict:';
/** The day-pin refusal, surfaced distinctly by the conflicts screen. */
export const CONFLICT_DATE_NOT_TODAY = `${CONFLICT_PREFIX}date_not_today`;
/** A Tier-2 count already held for a manager. Retrying only mints another hold. */
export const CONFLICT_MANAGER_HOLD = `${CONFLICT_PREFIX}manager_hold`;

/**
 * Marks a row whose retry is pointless until INFRASTRUCTURE changes — the app
 * answered, object storage did not. Retried (unlike a conflict) but surfaced
 * distinctly (unlike a plain offline failure).
 *
 * This prefix exists because of a real, fully silent outage: `load_photos` held
 * ZERO rows in production, ever. Every browser upload since the feature shipped
 * had failed the CORS preflight against the R2 bucket (403 — the bucket simply
 * had no CORS rule), and JT's iPad had quietly accumulated 97 pending uploads.
 * A blocked preflight surfaces in the browser as an opaque `TypeError`, which is
 * byte-identical to the one a genuinely offline device throws — so `isOfflineError`
 * classified it as "offline", the queue kept patiently retrying, and nothing on
 * the device or the server ever said otherwise. The server could not see it: a
 * request that dies at the preflight never arrives.
 *
 * The tell we now use is evidence we already have. `/api/photos/upload-url` is
 * OUR endpoint; if minting SUCCEEDED and the subsequent PUT died at the network
 * layer, the device demonstrably has a working connection to the app and cannot
 * reach storage. That is not offline, and it must not be painted as offline.
 */
export const BLOCKED_PREFIX = 'blocked:';
/** Mint succeeded, R2 PUT died at the network layer ⇒ storage unreachable. */
export const BLOCKED_UPLOAD = `${BLOCKED_PREFIX}r2_unreachable`;

/**
 * ADR-0078 G7 — the operator's SESSION ended. The most recoverable state there
 * is: somebody types a PIN and everything drains.
 *
 * A separate class from `conflict:` on purpose. A conflict needs a decision; an
 * expired session needs a sign-in, and parking these as conflicts would mean the
 * ordinary end of a shift silently converted a queue into a pile of items
 * demanding individual human adjudication.
 *
 * It is separate from a plain error too, because it never LOOKED like an error.
 * Operator sessions idle out after five minutes and `/api/photos/*` is not a
 * public path, so the middleware used to answer a session-less queue request
 * with a 307 to /login — which `fetch` follows to a 200 text/html page. `res.ok`
 * was true, so the mint "succeeded"; parsing the login page as JSON then threw a
 * SyntaxError that was recorded as a generic retryable error with no label. The
 * R2 PUT was never reached. The queue retried forever and nothing said why.
 *
 * Both halves are fixed: the middleware now answers `/api/*` with 401, and every
 * queue fetch below uses `redirect: 'manual'` so a redirect can never be
 * mistaken for a result even from a stale bundle or a cached SW.
 */
export const AUTH_PREFIX = 'auth:';
export const AUTH_EXPIRED = `${AUTH_PREFIX}session_expired`;

/**
 * True when a response is a sign-in demand rather than an answer: an explicit
 * 401, an opaque or manual redirect, or a 2xx whose content-type is HTML (the
 * login page). That last case is why this checks the CONTENT TYPE and not just
 * the status — a 200 full of HTML is exactly what the old bug looked like.
 *
 * 403 is deliberately NOT here. A 403 is authenticated-but-refused — most often
 * a photo queued against a load that now belongs to another operator's login —
 * and signing in again does not fix it. Those stay `conflict:`, which is the
 * screen that can actually resolve them.
 */
function isAuthResponse(res: Response): boolean {
  if (res.status === 401) return true;
  if (res.type === 'opaqueredirect' || res.redirected) return true;
  if (res.status >= 300 && res.status < 400) return true;
  // A 2xx carrying HTML is the login page arriving where JSON was expected.
  //
  // Deliberately narrowed to `html` rather than "anything that is not json".
  // The broader rule looked more defensive and was worse: a legitimate 2xx that
  // simply omits an explicit JSON content-type would be classified as an expired
  // session, which parks a perfectly good write behind a sign-in that will not
  // fix it. Caught by the per-load halting test, which started failing on stack
  // ONE because its 201 had no content-type header.
  const ct = res.headers.get('content-type') ?? '';
  if (res.ok && ct.includes('html')) return true;
  return false;
}

/**
 * G4 — a denormalised, INDEXED summary of `last_error`, maintained on every
 * write so the chrome's badge can be counted without reading a single record.
 *
 * `last_error` is a free-form string, so counting by it means opening every row
 * — and an upload row carries a multi-megabyte photo Blob that IndexedDB
 * deserialises whether or not you look at it. The badge refreshes every few
 * seconds on every screen; on the device holding 99 unsent photos that was
 * hundreds of blob reads per minute, on the single tab holding data that exists
 * nowhere else, purely to render a number. With this scalar indexed,
 * `countFromIndex` answers from the index alone and never touches a value.
 */
export type QueueState = 'active' | 'conflict' | 'blocked' | 'auth';

/** The single place `last_error` is translated into its indexed summary. */
export function stateFor(lastError: string | null | undefined): QueueState {
  if (lastError?.startsWith(CONFLICT_PREFIX)) return 'conflict';
  if (lastError?.startsWith(BLOCKED_PREFIX)) return 'blocked';
  // NOT a conflict: nothing needs adjudicating, somebody needs to sign in.
  if (lastError?.startsWith(AUTH_PREFIX)) return 'auth';
  return 'active';
}

export type UploadKind = 'bol' | 'weight_ticket' | 'door_open' | 'concern' | 'rejection';

export type PendingUpload = {
  id: string;
  load_id: string;
  kind: UploadKind;
  blob: Blob;
  content_type: string;
  byte_size: number;
  storage_key: string | null;
  upload_url: string | null;
  // ADR-0078 D3 — minted at capture, reused by every replay of THIS photo, so
  // `/api/photos/confirm` can tell a retry from a second photo. Nullable only so
  // a v1 row (which has none) still reads; those replay without dedupe exactly
  // as they did before.
  idempotency_key: string | null;
  queued_at: number;
  attempts: number;
  last_error: string | null;
  /** Indexed summary of `last_error`. See {@link QueueState}. */
  state: QueueState;
};

export type PendingAction = {
  id: string;
  /** Server-allowlisted write class, e.g. `operator.count.create`. */
  scope: string;
  /** Minted once, at the operator's action. Names the write across retries. */
  idempotency_key: string;
  /** Pacific day (YYYY-MM-DD) this entry was for; null when not day-addressed. */
  target_day: string | null;
  site_code: string;
  /** The live endpoint this was headed for. Recorded for diagnosis; replay
   *  always goes through /api/queue/replay, which owns the allowlist. */
  endpoint: string;
  /** Set for load-scoped writes so replay can halt a load's remaining steps. */
  load_id: string | null;
  args_json: string;
  queued_at: number;
  attempts: number;
  last_error: string | null;
  /** Indexed summary of `last_error`. See {@link QueueState}. */
  state: QueueState;
};

interface QueueDB extends DBSchema {
  pending_uploads: {
    key: string;
    value: PendingUpload;
    indexes: { 'by-queued-at': number; 'by-load': string; 'by-state': string };
  };
  pending_actions: {
    key: string;
    value: PendingAction;
    indexes: { 'by-queued-at': number; 'by-state': string };
  };
}

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null;

function getDb(): Promise<IDBPDatabase<QueueDB>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available (SSR or unsupported browser)'));
  }
  if (!dbPromise) {
    dbPromise = openDB<QueueDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains(UPLOADS)) {
          const s = db.createObjectStore(UPLOADS, { keyPath: 'id' });
          s.createIndex('by-queued-at', 'queued_at');
          s.createIndex('by-load', 'load_id');
          s.createIndex('by-state', 'state');
        }
        if (!db.objectStoreNames.contains(ACTIONS)) {
          const s = db.createObjectStore(ACTIONS, { keyPath: 'id' });
          s.createIndex('by-queued-at', 'queued_at');
          s.createIndex('by-state', 'state');
        }
        // An EXISTING v1 store has no `by-state` index; add it before the
        // backfill below populates the field it reads.
        if (oldVersion > 0 && oldVersion < 2) {
          for (const name of [UPLOADS, ACTIONS] as const) {
            const store = tx.objectStore(name);
            if (!store.indexNames.contains('by-state')) store.createIndex('by-state', 'state');
          }
        }
        // v1 → v2. A v1 action row predates `scope` / `idempotency_key` /
        // `target_day`, so it cannot be dispatched by the allowlist endpoint and
        // we cannot honestly guess what day it was for. It is FLAGGED as a
        // conflict, not deleted: the operator's work is theirs, and a screen
        // that says "this entry is from an older app version, here is what it
        // was" is the truthful outcome. In practice this store is empty in the
        // field — `enqueueAction` had no callers before v2 — so this path
        // guards a case that should not exist rather than one we expect.
        if (oldVersion > 0 && oldVersion < 2) {
          // G2 — legacy UPLOAD rows get an idempotency key.
          //
          // Without this the fix has a hole shaped exactly like the problem it
          // was built for. `enqueueUpload` mints a key for NEW captures only, so
          // every photo already queued by the v1 app would replay with no key,
          // `withIdempotency` would short-circuit on `key == null`, and the D3
          // duplicate-confirm defect would remain live for precisely the ~99
          // rows about to be drained through it — at volume, in one burst.
          //
          // Minting here is collision-safe by construction: `newQueueId` is a
          // millisecond timestamp plus 80 CSPRNG bits, and these rows have never
          // been presented to the server under any key, so there is nothing for
          // a fresh one to collide with.
          const uploadStore = tx.objectStore(UPLOADS);
          void uploadStore.openCursor().then(function walkUploads(cursor): Promise<void> | void {
            if (!cursor) return;
            const row = cursor.value as Partial<PendingUpload>;
            if (!row.idempotency_key || !row.state) {
              void cursor.update({
                ...(row as PendingUpload),
                idempotency_key: row.idempotency_key ?? newQueueId(),
                // Derived from the row's OWN existing `last_error`, so a legacy
                // row already parked as `conflict:mint 403` stays a conflict and
                // shows up on the conflicts screen rather than silently
                // re-entering the retry loop.
                state: stateFor(row.last_error),
              });
            }
            return cursor.continue().then(walkUploads);
          });

          const store = tx.objectStore(ACTIONS);
          void store.openCursor().then(function walk(cursor): Promise<void> | void {
            if (!cursor) return;
            const row = cursor.value as Partial<PendingAction>;
            if (!row.scope) {
              void cursor.update({
                ...(row as PendingAction),
                scope: row.scope ?? 'legacy.v1',
                idempotency_key: row.idempotency_key ?? '',
                target_day: row.target_day ?? null,
                site_code: row.site_code ?? '',
                endpoint: row.endpoint ?? '',
                load_id: row.load_id ?? null,
                last_error: `${CONFLICT_PREFIX}legacy_v1_entry`,
                state: 'conflict',
              });
            }
            return cursor.continue().then(walk);
          });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Mint an idempotency key. Called ONCE per operator action, at the moment they
 * act — not per attempt. A key minted per attempt would make every retry a new
 * write, which is the bug this whole mechanism exists to close.
 */
export function newIdempotencyKey(): string {
  return newQueueId();
}

export type EnqueueUploadInput = {
  load_id: string;
  kind: UploadKind;
  blob: Blob;
  content_type: string;
  storage_key?: string | null;
  upload_url?: string | null;
  idempotency_key?: string | null;
};

export async function enqueueUpload(input: EnqueueUploadInput): Promise<PendingUpload> {
  const db = await getDb();
  const row: PendingUpload = {
    id: newQueueId(),
    load_id: input.load_id,
    kind: input.kind,
    blob: input.blob,
    content_type: input.content_type,
    byte_size: input.blob.size,
    storage_key: input.storage_key ?? null,
    upload_url: input.upload_url ?? null,
    idempotency_key: input.idempotency_key ?? newQueueId(),
    queued_at: Date.now(),
    attempts: 0,
    last_error: null,
    state: 'active',
  };
  await db.put(UPLOADS, row);
  notifyEnqueued();
  return row;
}

// ── ADR-0078 G8 — enqueue notifications ───────────────────────────────────
//
// The drain engine subscribes so a write that just failed over to the queue is
// retried IMMEDIATELY rather than up to 30 seconds later. That is the difference
// between the queue being a retry path and being a waiting room.
//
// A plain module-level subscriber set rather than an EventTarget: this module is
// already the single owner of queue state, the engine is the only subscriber,
// and a listener that throws must not be able to break the enqueue that
// triggered it (hence the try/catch below — losing a notification is survivable,
// losing the write is not).
type EnqueueListener = () => void;
const enqueueListeners = new Set<EnqueueListener>();

export function subscribeToEnqueue(fn: EnqueueListener): () => void {
  enqueueListeners.add(fn);
  return () => {
    enqueueListeners.delete(fn);
  };
}

function notifyEnqueued(): void {
  for (const fn of enqueueListeners) {
    try {
      fn();
    } catch {
      // A subscriber's failure is its own problem. The row is already durable.
    }
  }
}

export type EnqueueActionInput = {
  scope: string;
  site_code: string;
  target_day: string | null;
  idempotency_key: string;
  payload: unknown;
  endpoint: string;
  load_id?: string | null;
};

export async function enqueueAction(input: EnqueueActionInput): Promise<PendingAction> {
  const db = await getDb();
  const row: PendingAction = {
    id: newQueueId(),
    scope: input.scope,
    idempotency_key: input.idempotency_key,
    target_day: input.target_day,
    site_code: input.site_code,
    endpoint: input.endpoint,
    load_id: input.load_id ?? null,
    args_json: JSON.stringify(input.payload),
    queued_at: Date.now(),
    attempts: 0,
    last_error: null,
    state: 'active',
  };
  await db.put(ACTIONS, row);
  notifyEnqueued();
  return row;
}

export type PendingSummary = {
  uploads: PendingUpload[];
  actions: PendingAction[];
};

export async function listPending(): Promise<PendingSummary> {
  const db = await getDb();
  const [uploads, actions] = await Promise.all([
    db.getAllFromIndex(UPLOADS, 'by-queued-at'),
    db.getAllFromIndex(ACTIONS, 'by-queued-at'),
  ]);
  return { uploads, actions };
}

export function isConflict(row: { last_error: string | null }): boolean {
  return row.last_error?.startsWith(CONFLICT_PREFIX) ?? false;
}

/** Entries that need a person. Drives the conflicts screen and the chrome badge. */
export async function listConflicts(): Promise<PendingSummary> {
  const { uploads, actions } = await listPending();
  return { uploads: uploads.filter(isConflict), actions: actions.filter(isConflict) };
}

export async function conflictCount(): Promise<number> {
  const { uploads, actions } = await listConflicts();
  return uploads.length + actions.length;
}

/**
 * G4 — every badge count in ONE pass, and without ever touching a Blob.
 *
 * The chrome refreshes its counters every few seconds on whichever screen the
 * operator is on. Computing them from `listPending()` meant `getAllFromIndex`
 * over the uploads store — which DESERIALISES EVERY PHOTO BLOB — three times per
 * refresh. On the device holding 99 unsent photos that is ~300 blob reads a
 * minute, on the one tab holding data that exists nowhere else, to render a
 * number. Keys only: `getAllKeys` never materialises the record values, so the
 * cost is proportional to the row COUNT rather than to the megabytes.
 *
 * `last_error` is read through a cursor over the keys, not the values, so the
 * blobs stay on disk.
 */
export type QueueCounts = {
  pending: number;
  active: number;
  conflicts: number;
  blocked: number;
  /** Waiting on a sign-in. Recoverable by a PIN, not by a decision. */
  auth: number;
};

export async function queueCounts(): Promise<QueueCounts> {
  const db = await getDb();
  const [uAll, uConf, uBlock, uAuth, aAll, aConf, aBlock, aAuth] = await Promise.all([
    db.count(UPLOADS),
    db.countFromIndex(UPLOADS, 'by-state', 'conflict'),
    db.countFromIndex(UPLOADS, 'by-state', 'blocked'),
    db.countFromIndex(UPLOADS, 'by-state', 'auth'),
    db.count(ACTIONS),
    db.countFromIndex(ACTIONS, 'by-state', 'conflict'),
    db.countFromIndex(ACTIONS, 'by-state', 'blocked'),
    db.countFromIndex(ACTIONS, 'by-state', 'auth'),
  ]);
  const pending = uAll + aAll;
  const conflicts = uConf + aConf;
  return {
    pending,
    conflicts,
    blocked: uBlock + aBlock,
    auth: uAuth + aAuth,
    // Auth rows ARE still trying — a sign-in resumes them without any decision,
    // so they belong in the "waiting to send" number and not in the stuck one.
    active: pending - conflicts,
  };
}

export async function pendingCount(): Promise<number> {
  const db = await getDb();
  const [u, a] = await Promise.all([db.count(UPLOADS), db.count(ACTIONS)]);
  return u + a;
}

/**
 * Rows that are actually still trying — total MINUS conflicts.
 *
 * The chrome shows this, not `pendingCount`. A badge that folds permanently
 * parked rows into "waiting to send" reads as a queue that is not draining, and
 * an operator who watches a number sit at 99 through several shifts stops
 * believing the number — which is precisely how a real outage went unreported.
 * "12 waiting" and "87 need you" are two different sentences with two different
 * actions, and neither is served by showing 99.
 */
export async function activeCount(): Promise<number> {
  const { uploads, actions } = await listPending();
  return (
    uploads.filter((r) => !isConflict(r)).length + actions.filter((r) => !isConflict(r)).length
  );
}

export async function markUploadAttempt(id: string, error: string | null): Promise<void> {
  const db = await getDb();
  const row = await db.get(UPLOADS, id);
  if (!row) return;
  row.attempts += 1;
  row.last_error = error;
  row.state = stateFor(error);
  await db.put(UPLOADS, row);
}

export async function markActionAttempt(id: string, error: string | null): Promise<void> {
  const db = await getDb();
  const row = await db.get(ACTIONS, id);
  if (!row) return;
  row.attempts += 1;
  row.last_error = error;
  row.state = stateFor(error);
  await db.put(ACTIONS, row);
}

export async function removeUpload(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(UPLOADS, id);
}

export async function removeAction(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(ACTIONS, id);
}

/**
 * Operator resolution: clear a conflict flag so the next sweep re-attempts.
 *
 * The counterpart to Discard, and the one that was missing entirely. A
 * conflict-flagged row is skipped by every future sweep, and before ADR-0078
 * nothing in the shipped app could see or clear that flag — so a row parked for
 * a reason that had since STOPPED being true stayed parked forever, while still
 * being counted as pending.
 *
 * That is not hypothetical. Photo rows queued against a load owned by a
 * different operator login get 403 on re-mint and park; the bucket's CORS
 * misconfiguration parked others. Both refusals expire — the right operator logs
 * back in, the infrastructure is fixed — but the flag did not, so a device sat
 * at 99-and-not-draining with no way to say "try that again now".
 *
 * Attempts reset to 0 so backoff does not immediately re-park a row a person has
 * just deliberately asked to retry.
 */
export async function retryRow(id: string, kind: 'action' | 'upload'): Promise<void> {
  const db = await getDb();
  if (kind === 'upload') {
    const row = await db.get(UPLOADS, id);
    if (!row) return;
    // G3 — discard the cached presign along with the flag.
    //
    // `queued_at` is reset so backoff does not immediately re-park a row a
    // person just asked to retry — but `replayUpload` decides staleness from
    // `queued_at` too, so resetting it alone makes a presign minted WEEKS ago
    // look fresh. Every retry would then PUT against a long-expired URL, get
    // 403, and the opening minutes of a 99-photo drain would read as total
    // failure — which is the shape of thing that gets a good deploy rolled
    // back. Clearing the key and URL forces a fresh mint on the next attempt,
    // which is what a human pressing "try again" means.
    await db.put(UPLOADS, {
      ...row,
      last_error: null,
      state: 'active',
      attempts: 0,
      queued_at: Date.now(),
      storage_key: null,
      upload_url: null,
    });
    return;
  }
  const row = await db.get(ACTIONS, id);
  if (!row) return;
  await db.put(ACTIONS, {
    ...row,
    last_error: null,
    state: 'active',
    attempts: 0,
    queued_at: Date.now(),
  });
}

/**
 * G5 — clear EVERY conflict flag, then sweep once.
 *
 * Thirty-three individual taps, each firing its own sweep, is not a drain plan;
 * it is a way to make an operator give up halfway through and leave the rest
 * parked. Returns how many rows were released so the screen can say so.
 *
 * Deliberately clears flags for ALL conflict rows including day-refused ones:
 * those will simply be refused again and re-park, which is the correct and
 * visible outcome. Silently excluding them would leave a "Retry all" that
 * quietly does not retry all.
 */
export async function retryAllConflicts(): Promise<number> {
  const { uploads, actions } = await listConflicts();
  for (const row of uploads) await retryRow(row.id, 'upload');
  for (const row of actions) await retryRow(row.id, 'action');
  return uploads.length + actions.length;
}

export async function getAction(id: string): Promise<PendingAction | undefined> {
  const db = await getDb();
  return db.get(ACTIONS, id);
}

export async function updateUpload(row: PendingUpload): Promise<void> {
  const db = await getDb();
  await db.put(UPLOADS, row);
}

/**
 * Operator resolution: re-file a day-refused entry against TODAY.
 *
 * This is the ONLY path by which a queued entry's day may change, and it exists
 * precisely so the automatic path never has to. The distinction is the whole
 * point of ADR-0078's day pin: a machine retargeting an entry is a silent
 * mis-filing; a person choosing to re-file one, having been shown which day it
 * was for and which day it would become, is a decision.
 *
 * A NEW idempotency key is minted, because this is genuinely a different write —
 * a different day is different data. Reusing the old key would earn a 409
 * `idempotency_key_reused`, which is the correct refusal for exactly this
 * reason. Safe to mint one: the original was refused before it wrote anything.
 */
export async function resubmitActionToToday(
  id: string,
  todayISO: string,
  dayField: string,
): Promise<PendingAction | null> {
  const db = await getDb();
  const row = await db.get(ACTIONS, id);
  if (!row) return null;
  const payload = JSON.parse(row.args_json) as Record<string, unknown>;
  payload[dayField] = todayISO;
  const next: PendingAction = {
    ...row,
    idempotency_key: newQueueId(),
    target_day: todayISO,
    args_json: JSON.stringify(payload),
    attempts: 0,
    last_error: null,
    state: 'active',
    queued_at: Date.now(),
  };
  await db.put(ACTIONS, next);
  return next;
}

// Backoff per ADR-0006 — capped exponential.
function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, 60);
}

function isReady(row: { attempts: number; queued_at: number; last_error: string | null }): boolean {
  if (row.attempts === 0) return true;
  const waitMs = backoffSeconds(row.attempts) * 1000;
  return Date.now() - row.queued_at >= waitMs;
}

export type ReplayResult = {
  uploads_replayed: number;
  uploads_failed: number;
  actions_replayed: number;
  actions_failed: number;
  /** Rows now needing a person. Drives the chrome's conflicts affordance. */
  conflicts: number;
  /** Rows blocked on unreachable object storage (see BLOCKED_UPLOAD). */
  blocked: number;
  /** Rows waiting on a sign-in (see AUTH_EXPIRED). */
  auth: number;
  /**
   * Did this sweep actually REACH the server?
   *
   * `true`  — at least one request got an HTTP response back.
   * `false` — requests were attempted and every one died at the network layer,
   *           or the device reported itself offline before trying.
   * `null`  — nothing was attempted (empty queue), so this sweep is no evidence
   *           either way and the caller must not read it as success.
   *
   * Without this, an offline sweep was indistinguishable from a successful one:
   * `replayAll` early-returns a fully-formed result when `navigator.onLine` is
   * false, so an observer seeing "a result with no auth and no blocked rows"
   * would paint the badge GREEN on a device with no network — which is the
   * connection-visibility guarantee this ADR exists to provide, reversed.
   */
  reached: boolean | null;
};

function classify(status: number): boolean {
  // A hard 4xx cannot be fixed by trying again — session expired, load
  // reassigned, wrong day, key reused. 408 is a timeout and IS retryable.
  return status >= 400 && status < 500 && status !== 408;
}

/**
 * Set by any fetch that returns an HTTP response during a sweep. Distinguishes
 * "the server said no" from "nothing reached the server" — the difference
 * between a conflict and a dead uplink, and the reason the badge can tell them
 * apart.
 */
let sweepReachedServer = false;

async function replayUpload(row: PendingUpload): Promise<{ ok: boolean; error?: string }> {
  // Set once the mint round-trips. From that point a network-layer failure is
  // proof that the APP is reachable and storage is not — see BLOCKED_UPLOAD.
  let appReachable = false;
  try {
    let storage_key = row.storage_key;
    let upload_url = row.upload_url;

    const PRESIGN_TTL_MS = 8 * 60 * 1000;
    const stale = !upload_url || Date.now() - row.queued_at > PRESIGN_TTL_MS;

    if (!storage_key || stale) {
      const mint = await fetch('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `manual` so a redirect surfaces AS a redirect. Following it lands on
        // the login page, whose 200 would otherwise read as a successful mint.
        redirect: 'manual',
        body: JSON.stringify({
          load_id: row.load_id,
          kind: row.kind,
          content_type: row.content_type,
        }),
      });
      sweepReachedServer = true;
      // Checked BEFORE `mint.ok`, because the whole defect was an auth failure
      // that arrived wearing a 200.
      if (isAuthResponse(mint)) return { ok: false, error: AUTH_EXPIRED };
      if (!mint.ok) {
        return {
          ok: false,
          error: `${classify(mint.status) ? CONFLICT_PREFIX : ''}mint ${mint.status}`,
        };
      }
      appReachable = true;
      const minted = (await mint.json()) as { storage_key: string; upload_url: string | null };
      storage_key = minted.storage_key;
      upload_url = minted.upload_url;
      row.storage_key = storage_key;
      row.upload_url = upload_url;
      row.queued_at = Date.now();
      await updateUpload(row);
    }

    if (upload_url) {
      // Isolated try/catch: a network-layer throw HERE is the CORS/preflight
      // class, and it must be distinguishable from the device being offline.
      // Bare `fetch` rejection is all a blocked preflight ever produces —
      // the browser will not tell JavaScript that a preflight was refused.
      try {
        const put = await fetch(upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': row.content_type },
          body: row.blob,
        });
        if (!put.ok) return { ok: false, error: `R2 PUT ${put.status}` };
      } catch (e) {
        if (appReachable) return { ok: false, error: BLOCKED_UPLOAD };
        throw e;
      }
    }

    // ADR-0078 D3 — the key rides on the header so a confirm that already
    // landed returns its original row id instead of writing a second one. Note
    // the re-mint above deliberately does NOT invalidate it: the server hashes
    // load_id + kind, not the storage_key, for exactly this reason.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (row.idempotency_key) headers['Idempotency-Key'] = row.idempotency_key;

    const confirm = await fetch('/api/photos/confirm', {
      method: 'POST',
      headers,
      redirect: 'manual',
      body: JSON.stringify({
        load_id: row.load_id,
        kind: row.kind,
        storage_key,
        byte_size: row.byte_size,
      }),
    });
    sweepReachedServer = true;
    if (isAuthResponse(confirm)) return { ok: false, error: AUTH_EXPIRED };
    if (!confirm.ok) {
      return {
        ok: false,
        error: `${classify(confirm.status) ? CONFLICT_PREFIX : ''}confirm ${confirm.status}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}

async function replayAction(row: PendingAction): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/queue/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'manual',
      body: JSON.stringify({
        scope: row.scope,
        site_code: row.site_code,
        idempotency_key: row.idempotency_key || null,
        target_day: row.target_day,
        payload: JSON.parse(row.args_json) as unknown,
      }),
    });
    sweepReachedServer = true;
    if (isAuthResponse(res)) return { ok: false, error: AUTH_EXPIRED };
    if (res.ok) return { ok: true };

    // 422 `date_not_today` is the day pin. It is a CONFLICT, deliberately: the
    // entry is intact, the server refused to guess, and a person decides whether
    // it is re-filed against today or discarded.
    if (res.status === 422) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'date_not_today') return { ok: false, error: CONFLICT_DATE_NOT_TODAY };
      // A Tier-2 count is HELD, not refused, and `createHold` sits outside the
      // idempotency claim by design. So every replay of this entry mints ANOTHER
      // hold, and a manager releasing two holds writes two anchor snapshots —
      // the duplicate-anchor defect, reintroduced through the retry path. Given
      // its own conflict code so the screen can say "waiting on a manager" and
      // suppress Retry.
      if (body.error === 'manager_approval_required') {
        return { ok: false, error: CONFLICT_MANAGER_HOLD };
      }
    }
    return {
      ok: false,
      error: `${classify(res.status) ? CONFLICT_PREFIX : ''}replay ${res.status}`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}

let replayInFlight: Promise<ReplayResult> | null = null;
/** A sweep was requested while one was already running. See `replayAll`. */
let replayDirty = false;

export function replayAll(): Promise<ReplayResult> {
  // Concurrent callers share the in-flight sweep — but that sweep has ALREADY
  // captured its row list, so anything enqueued after it started is invisible to
  // it. During a long drain (99 photos takes minutes) every capture made while
  // it runs would otherwise wait for the next 30s tick, which is exactly the
  // "waiting room" the drain engine exists to eliminate. One trailing re-sweep
  // picks them up; a flag rather than a loop, so a steady stream of captures
  // cannot spin this forever.
  if (replayInFlight) {
    replayDirty = true;
    return replayInFlight;
  }
  replayInFlight = (async () => {
    const result: ReplayResult = {
      uploads_replayed: 0,
      uploads_failed: 0,
      actions_replayed: 0,
      actions_failed: 0,
      conflicts: 0,
      blocked: 0,
      auth: 0,
      reached: null,
    };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const c = await queueCounts();
      result.conflicts = c.conflicts;
      result.blocked = c.blocked;
      result.auth = c.auth;
      // Explicitly NOT null: the device told us it is offline. That is evidence.
      result.reached = false;
      return result;
    }
    const { uploads, actions } = await listPending();
    sweepReachedServer = false;
    const attempted = uploads.length + actions.length > 0;

    // Loads whose remaining steps must NOT be applied this sweep. A load's
    // actions describe a sequence; running step 3 after step 2 was refused
    // would drive the server through a state the operator never produced.
    const halted = new Set<string>();

    for (const row of uploads) {
      if (isConflict(row)) continue;
      if (!isReady(row)) continue;
      if (row.load_id && halted.has(row.load_id)) continue;
      const r = await replayUpload(row);
      if (r.ok) {
        await removeUpload(row.id);
        result.uploads_replayed += 1;
      } else {
        await markUploadAttempt(row.id, r.error ?? 'unknown');
        result.uploads_failed += 1;
        // ANY failure halts the load, not just a conflict. Ordering within a
        // load is the stated contract, and a 500 or a dropped connection breaks
        // it exactly as thoroughly as a 409 does — a `finish_unload` queued
        // behind a stack that merely 500'd would otherwise replay and commit a
        // total that omits it.
        if (row.load_id) halted.add(row.load_id);
      }
    }

    // `listPending` reads the `by-queued-at` index, so this iterates in the
    // order the operator acted. That order is the contract — a queue that
    // replays a correction before the value it corrects is worse than one that
    // does not replay at all.
    for (const row of actions) {
      if (isConflict(row)) continue;
      if (!isReady(row)) continue;
      if (row.load_id && halted.has(row.load_id)) continue;
      const r = await replayAction(row);
      if (r.ok) {
        await removeAction(row.id);
        result.actions_replayed += 1;
      } else {
        await markActionAttempt(row.id, r.error ?? 'unknown');
        result.actions_failed += 1;
        // See above: any failure, not just a conflict.
        if (row.load_id) halted.add(row.load_id);
      }
    }

    const counts = await queueCounts();
    result.conflicts = counts.conflicts;
    result.blocked = counts.blocked;
    result.auth = counts.auth;
    // Nothing attempted ⇒ no evidence, and `null` says so rather than claiming
    // a healthy connection off an empty queue.
    result.reached = attempted ? sweepReachedServer : null;
    return result;
  })().finally(() => {
    replayInFlight = null;
    if (replayDirty) {
      replayDirty = false;
      void replayAll();
    }
  });
  return replayInFlight;
}

// Heuristic for "this fetch failed because we're offline / network is
// unreachable" — distinguishes from hard 4xx/5xx that we should NOT
// queue. TypeError "Failed to fetch" is what every browser throws when
// the network stack itself rejects the request.
export function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (e instanceof TypeError) return true;
  return false;
}
