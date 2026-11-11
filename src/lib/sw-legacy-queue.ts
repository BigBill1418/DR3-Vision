// ADR-0006 Amendment 1 — drop a retired Serwist background-sync queue without
// replaying it.
//
// Serwist keeps every BackgroundSyncPlugin queue in ONE database
// (`serwist-background-sync`, store `requests`, index `queueName`; see
// node_modules/serwist/dist/chunks/printInstallDetails-*.js,
// `BackgroundSyncQueueDb`). Constructing a `BackgroundSyncQueue` to empty it is
// not an option: on a browser without the Background Sync API (iPad Safari) the
// constructor REPLAYS the queue immediately. So the rows are deleted here with
// raw IndexedDB and never read back as requests.
//
// Kept free of service-worker globals so it runs under Vitest with
// fake-indexeddb; `sw.ts` passes `self.indexedDB`.

export const BG_SYNC_DB_NAME = 'serwist-background-sync';
const STORE = 'requests';
const INDEX = 'queueName';

/** Open Serwist's database only if it already exists; resolve null otherwise. */
function openExisting(factory: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const req = factory.open(BG_SYNC_DB_NAME);
    // No version given: an upgrade can only mean the database did not exist.
    // Abort it so this purge does not create an empty v1 database.
    req.onupgradeneeded = () => {
      created = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => (created ? resolve(null) : reject(req.error));
    req.onblocked = () => resolve(null);
  });
}

/** Delete every queued request in `queueName`. Returns how many were deleted. */
export async function purgeBackgroundSyncQueue(
  factory: IDBFactory,
  queueName: string,
): Promise<number> {
  const db = await openExisting(factory);
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(STORE)) return 0;
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      let deleted = 0;
      const cursorReq = tx
        .objectStore(STORE)
        .index(INDEX)
        .openKeyCursor(IDBKeyRange.only(queueName));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        tx.objectStore(STORE).delete(cursor.primaryKey);
        deleted += 1;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
