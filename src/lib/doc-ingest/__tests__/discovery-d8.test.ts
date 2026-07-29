// ADR-0067 §3.2 D8 — every operational condition, with its defined NON-SILENT
// behaviour asserted.
//
// D8 is a list of things that WILL happen in production, and the requirement is
// not merely that each is handled but that none of them is handled QUIETLY. So
// each test asserts two things: the state Vision lands in, and the fact that
// somebody is told.
//
// The conditions covered here are the discovery/traversal half:
//   share revoked · owner leaves · renamed · moved · deleted · shared twice ·
//   folder shared (later additions) · nested folders (depth limit)
//
// The content half (.xlsm, password-protected, oversize) lives in
// parse.test.ts and ingest-d8.test.ts; subscription lapse and tenant auth
// failure live in subscriptions.test.ts and sweep.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDiscovery } from '../discovery';
import {
  DocIngestAccessDeniedError,
  DocIngestNotFoundError,
  type DocIngestGraph,
  type GraphDriveItem,
} from '../graph';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));

const NOW = new Date('2026-07-29T12:00:00.000Z');

function item(over: Partial<GraphDriveItem> & { id: string }): GraphDriveItem {
  return {
    driveId: 'drive-A',
    name: 'file.xlsm',
    isFolder: false,
    webUrl: null,
    ctag: 'ctag-1',
    etag: 'etag-1',
    size: 1024,
    contentType: null,
    lastModifiedAt: null,
    lastModifiedBy: null,
    ownerUpn: 'kelsey@svdp.us',
    parentItemId: null,
    parentPath: null,
    deleted: false,
    ...over,
  };
}

/** A Graph stub whose behaviour each test configures. */
function makeGraph(over: Partial<DocIngestGraph> = {}): DocIngestGraph {
  return {
    listSharedWithMe: async () => [],
    listChildren: async () => [],
    getItem: async () => item({ id: 'x' }),
    deltaForDrive: async () => ({ items: [], deltaLink: null }),
    downloadItem: async () => new Uint8Array(),
    createSubscription: async () => ({ id: 's', expirationDateTime: '', resource: '' }),
    renewSubscription: async () => ({ id: 's', expirationDateTime: '', resource: '' }),
    deleteSubscription: async () => undefined,
    ...over,
  };
}

let prisma: FakeDocIngestPrisma;

beforeEach(() => {
  resetFakeIds();
  prisma = makeFakePrisma();
});

const p = () => prisma as unknown as never;

function openAnomalies(kind?: string) {
  return prisma._stores.anomalies.filter(
    (a) => a['status'] === 'open' && (kind === undefined || a['kind'] === kind),
  );
}

describe('D8 — same file shared twice (dedup)', () => {
  it('produces ONE logical source, and records that the dedup happened', async () => {
    // Two colleagues share the same workbook: two entries, one (driveId, itemId).
    const shared = item({ id: 'item-1', name: 'Daily Log.xlsm' });
    const graph = makeGraph({ listSharedWithMe: async () => [shared, { ...shared }] });

    const result = await runDiscovery(p(), graph, undefined, { now: NOW });

    expect(prisma._stores.sources).toHaveLength(1);
    expect(result.deduped).toBe(1);
    // The counter is the EVIDENCE — without it the single row looks like a
    // coincidence rather than a deliberate merge.
    expect(prisma._stores.sources[0]?.['shared_by_count']).toBe(2);
  });
});

describe('D8 — renamed and moved (id-keyed identity)', () => {
  it('a RENAME updates the same row rather than creating a second source', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', name: 'Daily Log.xlsm' })],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });
    const originalId = prisma._stores.sources[0]?.['id'];

    const graph2 = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', name: 'Daily Log FINAL v2.xlsm' })],
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(prisma._stores.sources).toHaveLength(1);
    expect(prisma._stores.sources[0]?.['id']).toBe(originalId);
    // The new name IS reflected — identity survives, the label follows.
    expect(prisma._stores.sources[0]?.['display_name']).toBe('Daily Log FINAL v2.xlsm');
  });

  it('a MOVE (new parent + new path) updates the same row', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', parentPath: '/drive/root:/2026' })],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });
    const originalId = prisma._stores.sources[0]?.['id'];

    const graph2 = makeGraph({
      listSharedWithMe: async () => [
        item({ id: 'item-1', parentPath: '/drive/root:/Archive/2026', parentItemId: 'folder-9' }),
      ],
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(prisma._stores.sources).toHaveLength(1);
    expect(prisma._stores.sources[0]?.['id']).toBe(originalId);
    expect(prisma._stores.sources[0]?.['path_hint']).toBe('/drive/root:/Archive/2026');
  });
});

describe('D8 — share revoked vs file deleted', () => {
  it('a 403 marks access_denied and raises an access_denied anomaly, NOT "disappeared"', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', name: 'Rates.xlsx' })],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [],
      getItem: async () => {
        throw new DocIngestAccessDeniedError('/drives/drive-A/items/item-1');
      },
    });
    const result = await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(result.lostAccess).toBe(1);
    expect(prisma._stores.sources[0]?.['state']).toBe('access_denied');
    const anomaly = openAnomalies('access_denied')[0];
    expect(anomaly).toBeDefined();
    // Collapsing this into "disappeared" is how a lapsed share goes unnoticed.
    expect(openAnomalies('source_disappeared')).toHaveLength(0);
    expect(String(anomaly?.['detail'])).toContain('Rates.xlsx');
  });

  it('a 404 marks disappeared, RETAINS the row, and says so', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', name: 'Gone.xlsx' })],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [],
      getItem: async () => {
        throw new DocIngestNotFoundError('/drives/drive-A/items/item-1');
      },
    });
    const result = await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(result.disappeared).toBe(1);
    // Last-known state is the point: deleting our record of a deleted document
    // would destroy the only remaining evidence of what it said.
    expect(prisma._stores.sources).toHaveLength(1);
    expect(prisma._stores.sources[0]?.['state']).toBe('disappeared');
    expect(openAnomalies('source_disappeared')).toHaveLength(1);
  });

  it('a TRANSIENT failure leaves the source alone — a blip is not a deletion', async () => {
    const graph1 = makeGraph({ listSharedWithMe: async () => [item({ id: 'item-1' })] });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [],
      getItem: async () => {
        throw new Error('socket hang up');
      },
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(prisma._stores.sources[0]?.['state']).toBe('active');
    expect(openAnomalies()).toHaveLength(0);
  });

  it('re-seeing a lost source restores it and RESOLVES the anomaly rather than deleting it', async () => {
    const graph1 = makeGraph({ listSharedWithMe: async () => [item({ id: 'item-1' })] });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [],
      getItem: async () => {
        throw new DocIngestAccessDeniedError('x');
      },
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });
    expect(openAnomalies('access_denied')).toHaveLength(1);

    await runDiscovery(p(), graph1, undefined, { now: NOW });

    expect(prisma._stores.sources[0]?.['state']).toBe('active');
    expect(openAnomalies('access_denied')).toHaveLength(0);
    // Retained as resolved — the evidence that it was wrong and got fixed.
    expect(prisma._stores.anomalies).toHaveLength(1);
    expect(prisma._stores.anomalies[0]?.['status']).toBe('resolved');
  });
});

describe('D8 — owner leaves / account disabled', () => {
  it('raises owner_lost NAMING the previous owner when all of their shares vanish at once', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [
        item({ id: 'a', name: 'A.xlsx', ownerUpn: 'departing@svdp.us' }),
        item({ id: 'b', name: 'B.xlsx', ownerUpn: 'departing@svdp.us' }),
        item({ id: 'c', name: 'C.xlsx', ownerUpn: 'staying@svdp.us' }),
      ],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [
        item({ id: 'c', name: 'C.xlsx', ownerUpn: 'staying@svdp.us' }),
      ],
      getItem: async () => {
        throw new DocIngestNotFoundError('gone');
      },
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });

    const ownerLost = openAnomalies('owner_lost')[0];
    expect(ownerLost).toBeDefined();
    // Naming the owner is the requirement: once the account is gone, the stored
    // `owner_upn` is the only place that name still exists.
    expect(String(ownerLost?.['detail'])).toContain('departing@svdp.us');
    expect(String(ownerLost?.['detail'])).toContain('A.xlsx');
    // And it is HONEST about what it cannot prove.
    expect(String(ownerLost?.['detail'])).toContain('User.Read');
  });

  it('deduplicates: no per-file page on top of the owner-level one (ADR-0037 Q4)', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [
        item({ id: 'a', ownerUpn: 'departing@svdp.us' }),
        item({ id: 'b', ownerUpn: 'departing@svdp.us' }),
      ],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [],
      getItem: async () => {
        throw new DocIngestNotFoundError('gone');
      },
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(openAnomalies('owner_lost')).toHaveLength(1);
    expect(openAnomalies('source_disappeared')).toHaveLength(0);
  });

  it('a SINGLE revoked share is not mistaken for a departure', async () => {
    const graph1 = makeGraph({
      listSharedWithMe: async () => [
        item({ id: 'a', ownerUpn: 'kelsey@svdp.us' }),
        item({ id: 'b', ownerUpn: 'kelsey@svdp.us' }),
      ],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const graph2 = makeGraph({
      listSharedWithMe: async () => [item({ id: 'b', ownerUpn: 'kelsey@svdp.us' })],
      getItem: async () => {
        throw new DocIngestAccessDeniedError('x');
      },
    });
    await runDiscovery(p(), graph2, undefined, { now: NOW });

    expect(openAnomalies('owner_lost')).toHaveLength(0);
    expect(openAnomalies('access_denied')).toHaveLength(1);
  });
});

describe('D8 — shared folder', () => {
  it('walks into a shared folder and tracks the files inside it', async () => {
    const folder = item({ id: 'folder-1', name: 'Daily Logs', isFolder: true, ctag: null });
    const graph = makeGraph({
      listSharedWithMe: async () => [folder],
      listChildren: async () => [
        item({ id: 'child-1', name: 'July.xlsm', parentItemId: 'folder-1' }),
      ],
    });

    await runDiscovery(p(), graph, undefined, { now: NOW });

    expect(prisma._stores.sources).toHaveLength(2);
    const child = prisma._stores.sources.find((s) => s['item_id'] === 'child-1');
    expect(child?.['depth']).toBe(1);
    expect(child?.['parent_item_id']).toBe('folder-1');
  });

  it('PICKS UP A FILE ADDED LATER — the requirement that makes folder-sharing worth anything', async () => {
    const folder = item({ id: 'folder-1', name: 'Daily Logs', isFolder: true, ctag: null });

    const first = makeGraph({
      listSharedWithMe: async () => [folder],
      listChildren: async () => [item({ id: 'child-1', name: 'July.xlsm' })],
    });
    await runDiscovery(p(), first, undefined, { now: NOW });
    expect(prisma._stores.sources).toHaveLength(2);

    // Nobody re-shares anything; a colleague just drops a new file in.
    const second = makeGraph({
      listSharedWithMe: async () => [folder],
      listChildren: async () => [
        item({ id: 'child-1', name: 'July.xlsm' }),
        item({ id: 'child-2', name: 'August.xlsm' }),
      ],
    });
    const result = await runDiscovery(p(), second, undefined, { now: NOW });

    expect(result.discovered).toBe(1);
    expect(prisma._stores.sources.map((s) => s['item_id'])).toContain('child-2');
  });

  it('does not walk a folder Bill disabled', async () => {
    const folder = item({ id: 'folder-1', isFolder: true, ctag: null });
    const graph1 = makeGraph({
      listSharedWithMe: async () => [folder],
      listChildren: async () => [],
    });
    await runDiscovery(p(), graph1, undefined, { now: NOW });

    const row = prisma._stores.sources.find((s) => s['item_id'] === 'folder-1');
    if (row) row['enabled'] = false;

    const listChildren = vi.fn(async () => [item({ id: 'child-1' })]);
    await runDiscovery(
      p(),
      makeGraph({ listSharedWithMe: async () => [folder], listChildren }),
      undefined,
      {
        now: NOW,
      },
    );

    expect(listChildren).not.toHaveBeenCalled();
  });
});

describe('D8 — nested folders and the depth limit', () => {
  it('stops at the configured depth and RAISES depth_limit_reached rather than going quiet', async () => {
    // A chain: root → L1 → L2 → …
    const chain = (n: number): GraphDriveItem =>
      item({ id: `folder-${n}`, name: `L${n}`, isFolder: true, ctag: null });

    const graph = makeGraph({
      listSharedWithMe: async () => [chain(0)],
      listChildren: async (_drive, itemId) => {
        const depth = Number(itemId.split('-')[1] ?? 0);
        return [chain(depth + 1)];
      },
    });

    await runDiscovery(p(), graph, undefined, { now: NOW, maxDepth: 2 });

    const anomaly = openAnomalies('depth_limit_reached')[0];
    expect(anomaly).toBeDefined();
    // "There are files below here that Vision is NOT watching" is precisely the
    // thing that must never be silent.
    expect(String(anomaly?.['detail'])).toContain('NOT being watched');
    // Bounded: root + L1 + L2, and nothing deeper.
    expect(prisma._stores.sources).toHaveLength(3);
  });

  it('does not raise the anomaly when the tree fits inside the limit', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'folder-1', isFolder: true, ctag: null })],
      listChildren: async () => [item({ id: 'child-1' })],
    });
    await runDiscovery(p(), graph, undefined, { now: NOW, maxDepth: 5 });
    expect(openAnomalies('depth_limit_reached')).toHaveLength(0);
  });

  it('keeps the SHALLOWER placement when an item is reachable two ways', async () => {
    const folder = item({ id: 'folder-1', isFolder: true, ctag: null });
    const shared = item({ id: 'item-1', name: 'Shared both ways.xlsm' });
    const graph = makeGraph({
      listSharedWithMe: async () => [shared, folder],
      listChildren: async () => [shared],
    });

    const result = await runDiscovery(p(), graph, undefined, { now: NOW });

    expect(result.deduped).toBe(1);
    const row = prisma._stores.sources.find((s) => s['item_id'] === 'item-1');
    // Depth 0 — the placement a human actually chose.
    expect(row?.['depth']).toBe(0);
  });
});

describe('discovery — what it must NOT overwrite', () => {
  it('never revises a confirmed classification, a site scoping, or the kill switch', async () => {
    const graph = makeGraph({ listSharedWithMe: async () => [item({ id: 'item-1' })] });
    await runDiscovery(p(), graph, undefined, { now: NOW });

    const row = prisma._stores.sources[0];
    if (!row) throw new Error('expected a source');
    row['doc_class'] = 'daily_log_workbook';
    row['site_id'] = 'site-eugene';
    row['enabled'] = false;

    await runDiscovery(p(), graph, undefined, { now: NOW });

    // Re-seeing a file is not consent to re-enable it, and discovery has no
    // standing to revise a decision a human made.
    expect(row['doc_class']).toBe('daily_log_workbook');
    expect(row['site_id']).toBe('site-eugene');
    expect(row['enabled']).toBe(false);
  });
});
