// 2026-07-15 first-live-test defect: /move was called with the folder DISPLAY
// NAME as destinationId — Graph requires a folder id (or well-known name), so
// every move 400'd and no message ever left the Inbox. These tests pin the
// fixed contract: resolve-by-name (create if missing), cache the id, move by
// id, and re-resolve once on a stale cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    async getToken() {
      return { token: 'tok', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  },
}));

import { graphTransport } from './graph-transport';

type Call = { url: string; method: string; body: unknown };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CONFIG = {
  tenantId: 't',
  clientId: 'c',
  secret: 's',
  mailbox: 'approvals-dr3@svdp.us',
};

let calls: Call[];

function stubFetch(handler: (c: Call) => Response | undefined): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const res = handler(call);
      if (!res) throw new Error(`unstubbed fetch: ${call.method} ${call.url}`);
      return res;
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('graphTransport.moveMessage — folder id resolution', () => {
  it('resolves the display name to an id, moves by ID, and caches the id', async () => {
    stubFetch((c) => {
      if (c.url.includes('/mailFolders?')) {
        return jsonResponse(200, { value: [{ id: 'FOLDER-ID-1' }] });
      }
      if (c.url.includes('/move')) return jsonResponse(201, { id: 'moved-1' });
      return undefined;
    });
    const t = graphTransport(CONFIG, { processedFolder: 'Processed' });

    await t.moveMessage('m1', 'Processed');
    await t.moveMessage('m2', 'Processed');

    const moves = calls.filter((c) => c.url.includes('/move'));
    expect(moves).toHaveLength(2);
    for (const m of moves) {
      expect((m.body as { destinationId: string }).destinationId).toBe('FOLDER-ID-1');
    }
    // Resolution happened exactly ONCE (cached for the second move).
    expect(calls.filter((c) => c.url.includes('/mailFolders?'))).toHaveLength(1);
  });

  it('creates the folder when it does not exist yet', async () => {
    stubFetch((c) => {
      if (c.url.includes('/mailFolders?')) return jsonResponse(200, { value: [] });
      if (c.method === 'POST' && c.url.endsWith('/mailFolders')) {
        return jsonResponse(201, { id: 'CREATED-ID' });
      }
      if (c.url.includes('/move')) return jsonResponse(201, { id: 'moved-1' });
      return undefined;
    });
    const t = graphTransport(CONFIG, { processedFolder: 'Processed' });

    await t.moveMessage('m1', 'Processed');

    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/mailFolders'));
    expect((create?.body as { displayName: string }).displayName).toBe('Processed');
    const move = calls.find((c) => c.url.includes('/move'));
    expect((move?.body as { destinationId: string }).destinationId).toBe('CREATED-ID');
  });

  it('re-resolves once when the cached folder id has gone stale (404)', async () => {
    let resolveCount = 0;
    stubFetch((c) => {
      if (c.url.includes('/mailFolders?')) {
        resolveCount += 1;
        return jsonResponse(200, { value: [{ id: resolveCount === 1 ? 'STALE' : 'FRESH' }] });
      }
      if (c.url.includes('/move')) {
        const dest = (c.body as { destinationId: string }).destinationId;
        return dest === 'STALE' ? jsonResponse(404, {}) : jsonResponse(201, { id: 'ok' });
      }
      return undefined;
    });
    const t = graphTransport(CONFIG, { processedFolder: 'Processed' });

    await expect(t.moveMessage('m1', 'Processed')).resolves.toBe('ok');
    expect(resolveCount).toBe(2);
  });

  it('throws GraphContractDriftError when the retried move still fails', async () => {
    stubFetch((c) => {
      if (c.url.includes('/mailFolders?')) return jsonResponse(200, { value: [{ id: 'X' }] });
      if (c.url.includes('/move')) return jsonResponse(400, {});
      return undefined;
    });
    const t = graphTransport(CONFIG, { processedFolder: 'Processed' });

    await expect(t.moveMessage('m1', 'Processed')).rejects.toThrow(/move message m1/);
  });
});
