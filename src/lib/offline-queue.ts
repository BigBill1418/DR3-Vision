'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

// IndexedDB-backed offline queue for the operator iPad. Per CLAUDE.md
// hard rule #9 IndexedDB + Service Worker cache are the only persistence
// paths in the PWA shell — no localStorage, no sessionStorage. ADR-0006
// codifies the queue strategy; T-009 implements it.
//
// Two stores:
//   - `pending_uploads`  — photo blobs awaiting R2 PUT + /api/photos/confirm.
//                          One row per photo. Carries the storage_key from
//                          the original mint POST (when it succeeded) plus
//                          the original file blob.
//   - `pending_actions`  — operator server-action calls that did not reach
//                          the server. Replayed by re-POSTing to the same
//                          endpoint with the original arguments.
//
// Each row carries `attempts` and `last_error` so the queue UI can surface
// stuck items, and `queued_at` so backoff respects insertion time.
//
// IDs use a small Crockford-base32 ULID-ish encoding seeded by
// `Date.now()` + `crypto.getRandomValues()`. We don't pull in a ULID
// dependency because we already have hard constraints on the dep list
// (CLAUDE.md per ADR-0012 §4 — no new deps for T-009) and the only
// requirement is monotonic-ish lexicographic ordering for the replay
// loop, which 48-bit timestamp + 80 bits of randomness gives us.

const DB_NAME = 'dr3-vision-queue';
const DB_VERSION = 1;
const UPLOADS = 'pending_uploads';
const ACTIONS = 'pending_actions';

export type UploadKind = 'bol' | 'weight_ticket' | 'door_open' | 'concern' | 'rejection';

export type PendingUpload = {
  id: string;
  load_id: string;
  kind: UploadKind;
  blob: Blob;
  content_type: string;
  byte_size: number;
  // The storage_key returned by the original mint call. If the mint
  // also failed offline we leave this null and re-mint at replay.
  storage_key: string | null;
  // The presigned R2 PUT URL — only valid for ~10 min, so we treat it
  // as advisory. Replay re-mints if expired or null.
  upload_url: string | null;
  queued_at: number;
  attempts: number;
  last_error: string | null;
};

export type PendingAction = {
  id: string;
  // Free-form action name — e.g. 'bolCapturedAction'. The replay path
  // posts to /api/queue/replay with `{ action_name, args }`. T-009 ships
  // the photo-side queue; the action-side queue is wired here for the
  // workflow to extend later (server-action replay endpoint is a
  // follow-up — actions land synchronously on the iPad's network today
  // and only the photo path needs offline storage in the operator
  // happy-path verified by SPRINT-1-PLAN T-009 acceptance).
  action_name: string;
  args_json: string;
  queued_at: number;
  attempts: number;
  last_error: string | null;
};

interface QueueDB extends DBSchema {
  pending_uploads: {
    key: string;
    value: PendingUpload;
    indexes: { 'by-queued-at': number; 'by-load': string };
  };
  pending_actions: {
    key: string;
    value: PendingAction;
    indexes: { 'by-queued-at': number };
  };
}

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null;

function getDb(): Promise<IDBPDatabase<QueueDB>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available (SSR or unsupported browser)'));
  }
  if (!dbPromise) {
    dbPromise = openDB<QueueDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(UPLOADS)) {
          const s = db.createObjectStore(UPLOADS, { keyPath: 'id' });
          s.createIndex('by-queued-at', 'queued_at');
          s.createIndex('by-load', 'load_id');
        }
        if (!db.objectStoreNames.contains(ACTIONS)) {
          const s = db.createObjectStore(ACTIONS, { keyPath: 'id' });
          s.createIndex('by-queued-at', 'queued_at');
        }
      },
    });
  }
  return dbPromise;
}

function newId(): string {
  // 13-char timestamp (ms since epoch in base36) + 16-char random.
  // Lexicographically sortable for queue order.
  const ts = Date.now().toString(36).padStart(13, '0');
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let rand = '';
  for (const b of buf) rand += b.toString(36).padStart(2, '0');
  return `${ts}-${rand}`;
}

export type EnqueueUploadInput = {
  load_id: string;
  kind: UploadKind;
  blob: Blob;
  content_type: string;
  storage_key?: string | null;
  upload_url?: string | null;
};

export async function enqueueUpload(input: EnqueueUploadInput): Promise<PendingUpload> {
  const db = await getDb();
  const row: PendingUpload = {
    id: newId(),
    load_id: input.load_id,
    kind: input.kind,
    blob: input.blob,
    content_type: input.content_type,
    byte_size: input.blob.size,
    storage_key: input.storage_key ?? null,
    upload_url: input.upload_url ?? null,
    queued_at: Date.now(),
    attempts: 0,
    last_error: null,
  };
  await db.put(UPLOADS, row);
  return row;
}

export async function enqueueAction(action_name: string, args: unknown): Promise<PendingAction> {
  const db = await getDb();
  const row: PendingAction = {
    id: newId(),
    action_name,
    args_json: JSON.stringify(args),
    queued_at: Date.now(),
    attempts: 0,
    last_error: null,
  };
  await db.put(ACTIONS, row);
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

export async function pendingCount(): Promise<number> {
  const db = await getDb();
  const [u, a] = await Promise.all([db.count(UPLOADS), db.count(ACTIONS)]);
  return u + a;
}

export async function markUploadAttempt(id: string, error: string | null): Promise<void> {
  const db = await getDb();
  const row = await db.get(UPLOADS, id);
  if (!row) return;
  row.attempts += 1;
  row.last_error = error;
  await db.put(UPLOADS, row);
}

export async function markActionAttempt(id: string, error: string | null): Promise<void> {
  const db = await getDb();
  const row = await db.get(ACTIONS, id);
  if (!row) return;
  row.attempts += 1;
  row.last_error = error;
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

export async function updateUpload(row: PendingUpload): Promise<void> {
  const db = await getDb();
  await db.put(UPLOADS, row);
}

// Backoff per ADR-0006 — capped exponential. Avoids hammering the
// server when the same row keeps failing (e.g. session expired).
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
};

// Replay one upload: re-mint if needed, PUT to R2, POST confirm, remove
// on success. Conflict-resolution per ADR-0006 — the iPad's queued
// blob is authoritative for the operator's own action; if the server
// rejects with a hard 4xx (load reassigned, deleted, etc.) we mark the
// row as a flagged conflict by leaving it in the queue with a
// `conflict:` prefix in last_error so the manager portal's per-iPad
// queue depth metric (T-010 follow-up) can surface it. Hard 4xx is NOT
// retried, soft 5xx + network errors ARE retried.
async function replayUpload(row: PendingUpload): Promise<{ ok: boolean; error?: string }> {
  try {
    let storage_key = row.storage_key;
    let upload_url = row.upload_url;

    // Re-mint when we never had a key OR we suspect the URL has expired
    // (presigned R2 URLs are 10 min per src/lib/r2.ts; if more than 8
    // minutes have passed since this row was queued we re-mint).
    const PRESIGN_TTL_MS = 8 * 60 * 1000;
    const stale = !upload_url || Date.now() - row.queued_at > PRESIGN_TTL_MS;

    if (!storage_key || stale) {
      const mint = await fetch('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          load_id: row.load_id,
          kind: row.kind,
          content_type: row.content_type,
        }),
      });
      if (!mint.ok) {
        const conflict = mint.status >= 400 && mint.status < 500 && mint.status !== 408;
        return {
          ok: false,
          error: `${conflict ? 'conflict:' : ''}mint ${mint.status}`,
        };
      }
      const minted = (await mint.json()) as { storage_key: string; upload_url: string | null };
      storage_key = minted.storage_key;
      upload_url = minted.upload_url;
      row.storage_key = storage_key;
      row.upload_url = upload_url;
      row.queued_at = Date.now();
      await updateUpload(row);
    }

    if (upload_url) {
      const put = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': row.content_type },
        body: row.blob,
      });
      if (!put.ok) return { ok: false, error: `R2 PUT ${put.status}` };
    }

    const confirm = await fetch('/api/photos/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        load_id: row.load_id,
        kind: row.kind,
        storage_key,
        byte_size: row.byte_size,
      }),
    });
    if (!confirm.ok) {
      const conflict = confirm.status >= 400 && confirm.status < 500 && confirm.status !== 408;
      return {
        ok: false,
        error: `${conflict ? 'conflict:' : ''}confirm ${confirm.status}`,
      };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}

let replayInFlight: Promise<ReplayResult> | null = null;

export function replayAll(): Promise<ReplayResult> {
  if (replayInFlight) return replayInFlight;
  replayInFlight = (async () => {
    const result: ReplayResult = {
      uploads_replayed: 0,
      uploads_failed: 0,
      actions_replayed: 0,
      actions_failed: 0,
    };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return result;
    }
    const { uploads, actions } = await listPending();
    for (const row of uploads) {
      if (!isReady(row)) continue;
      // Conflict-flagged rows stay in the queue but do NOT auto-retry —
      // they require a manager-portal resolution. Hard 4xx during
      // re-mint or confirm sets the `conflict:` prefix.
      if (row.last_error?.startsWith('conflict:')) continue;
      const r = await replayUpload(row);
      if (r.ok) {
        await removeUpload(row.id);
        result.uploads_replayed += 1;
      } else {
        await markUploadAttempt(row.id, r.error ?? 'unknown');
        result.uploads_failed += 1;
      }
    }
    // Actions queue is wired but unused in T-009 scope (server actions
    // execute synchronously when online; the photo path is the offline
    // critical path per ADR-0006). Replay loop iterates it for parity
    // when later workflow stages opt in.
    for (const row of actions) {
      if (!isReady(row)) continue;
      if (row.last_error?.startsWith('conflict:')) continue;
      try {
        const res = await fetch('/api/queue/replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_name: row.action_name, args_json: row.args_json }),
        });
        if (res.ok) {
          await removeAction(row.id);
          result.actions_replayed += 1;
        } else {
          const conflict = res.status >= 400 && res.status < 500 && res.status !== 408;
          await markActionAttempt(row.id, `${conflict ? 'conflict:' : ''}replay ${res.status}`);
          result.actions_failed += 1;
        }
      } catch (e) {
        await markActionAttempt(row.id, e instanceof Error ? e.message : 'network');
        result.actions_failed += 1;
      }
    }
    return result;
  })().finally(() => {
    replayInFlight = null;
  });
  return replayInFlight;
}

// Heuristic for "this fetch failed because we're offline / network is
// unreachable" — distinguishes from hard 4xx/5xx that we should NOT
// queue. TypeError "Failed to fetch" is what every browser throws when
// the network stack itself rejects the request. Plus the explicit
// `navigator.onLine === false` short-circuit.
export function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (e instanceof TypeError) return true;
  return false;
}
