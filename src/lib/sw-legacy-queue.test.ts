// ADR-0006 Amendment 1 — purging the retired SW background-sync queue.
//
// The purge must (a) delete only the named queue's rows, (b) never send them,
// and (c) not CREATE Serwist's database on a device that never had one: an
// empty v1 database would make Serwist's own v3 open take the upgrade branch
// for no reason.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BG_SYNC_DB_NAME, purgeBackgroundSyncQueue } from './sw-legacy-queue';

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function seed(rows: Array<{ queueName: string }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open(BG_SYNC_DB_NAME, 3);
    req.onupgradeneeded = () => {
      req.result
        .createObjectStore('requests', { autoIncrement: true, keyPath: 'id' })
        .createIndex('queueName', 'queueName', { unique: false });
    };
    req.onsuccess = () => {
      const tx = req.result.transaction('requests', 'readwrite');
      for (const r of rows) tx.objectStore('requests').add({ ...r, timestamp: Date.now() });
      tx.oncomplete = () => {
        req.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function remaining(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = factory.open(BG_SYNC_DB_NAME);
    req.onsuccess = () => {
      const all = req.result.transaction('requests').objectStore('requests').getAll();
      all.onsuccess = () => {
        req.result.close();
        resolve((all.result as Array<{ queueName: string }>).map((r) => r.queueName));
      };
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('purgeBackgroundSyncQueue', () => {
  it('deletes every row of the named queue, keeps the others, and reports the count', async () => {
    await seed([
      { queueName: 'dr3-server-actions' },
      { queueName: 'dr3-photo-mint' },
      { queueName: 'dr3-server-actions' },
      { queueName: 'dr3-server-actions' },
    ]);
    expect(await purgeBackgroundSyncQueue(factory, 'dr3-server-actions')).toBe(3);
    expect(await remaining()).toEqual(['dr3-photo-mint']);
  });

  it('sends nothing: a purged write is dropped, never replayed', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seed([{ queueName: 'dr3-server-actions' }]);
    await purgeBackgroundSyncQueue(factory, 'dr3-server-actions');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('is a no-op on a second run (idempotent across re-activations)', async () => {
    await seed([{ queueName: 'dr3-server-actions' }]);
    expect(await purgeBackgroundSyncQueue(factory, 'dr3-server-actions')).toBe(1);
    expect(await purgeBackgroundSyncQueue(factory, 'dr3-server-actions')).toBe(0);
  });

  it('does not create the database on a device that never had one', async () => {
    expect(await purgeBackgroundSyncQueue(factory, 'dr3-server-actions')).toBe(0);
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).not.toContain(BG_SYNC_DB_NAME);
  });

  it('answers 0 when the database exists without the requests store', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = factory.open(BG_SYNC_DB_NAME, 1);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    expect(await purgeBackgroundSyncQueue(factory, 'dr3-server-actions')).toBe(0);
  });
});
