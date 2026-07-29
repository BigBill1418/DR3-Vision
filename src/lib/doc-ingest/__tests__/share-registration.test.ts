// ADR-0067 §3.2 D4/D8 — the `/shares` registration path and owner enrichment.
//
// Two defects are under test here, and neither one announces itself in
// production:
//
//   1. The sharing-URL encoding. `/shares/u!{token}` takes UNPADDED base64url,
//      and most SharePoint URLs happen to base64-encode into an alphabet with no
//      `+` or `/` in them — so a wrong encoder works when you try it by hand and
//      400s later, on the one document whose URL produces those characters. The
//      failure is data-dependent, which is exactly the kind that cannot be
//      caught by testing it once.
//
//   2. Owner enrichment. `sharedWithMe` carries `shared.sharedBy` but neither
//      `shared.owner` nor `createdBy`, so `owner_upn` was NULL on every source —
//      and a table of NULLs makes the "owner left the org" inference inert
//      without ever failing. It has to be asserted that the column gets
//      populated, AND that the extra call earning it can fail without taking
//      discovery down with it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSharingUrl, projectDriveItem, type GraphDriveItem } from '../graph';
import { runDiscovery, registerSharedItem } from '../discovery';
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
    name: 'Daily Log.xlsm',
    isFolder: false,
    webUrl: null,
    ctag: 'ctag-1',
    etag: 'etag-1',
    size: 1024,
    contentType: null,
    lastModifiedAt: null,
    lastModifiedBy: null,
    ownerUpn: null,
    parentItemId: null,
    parentPath: null,
    deleted: false,
    ...over,
  };
}

type Graph = Parameters<typeof runDiscovery>[1];

function makeGraph(over: Partial<Graph> = {}): Graph {
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

function sources(): Record<string, unknown>[] {
  return prisma._stores.sources;
}

// ── (B) the encoding ────────────────────────────────────────────────────────

describe('encodeSharingUrl — Microsoft’s documented u! share token', () => {
  it('matches the worked example from the Graph docs verbatim', () => {
    // https://learn.microsoft.com/graph/api/shares-get?view=graph-rest-1.0#encoding-sharing-urls
    const sharingUrl =
      'https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1';
    const expected = `u!${Buffer.from(sharingUrl, 'utf8')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\//g, '_')
      .replace(/\+/g, '-')}`;

    expect(encodeSharingUrl(sharingUrl)).toBe(expected);
    expect(encodeSharingUrl(sharingUrl).startsWith('u!')).toBe(true);
  });

  it('is base64URL, not base64: no +, no /, no = anywhere in the token', () => {
    // A URL engineered so its base64 contains BOTH `+` and `/` — the two
    // characters a naive encoder leaves in place and Graph then rejects. `?` and
    // `=` in the input matter too: they are what makes real SharePoint URLs
    // produce this alphabet in the first place.
    const url = 'https://svdp.sharepoint.com/:x:/g/personal/a?e=aa/bb+cc&d==ff~ÿ';
    const token = encodeSharingUrl(url);

    expect(token.startsWith('u!')).toBe(true);
    expect(token.slice(2)).not.toMatch(/[+/=]/);
    // And it must still round-trip to the original URL, or we encoded garbage
    // that merely LOOKS like a valid token.
    const b64 = token.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(url);
  });

  it('strips padding rather than percent-encoding it', () => {
    // 'https://a.sharepoint.com/x' is 26 bytes → base64 pads with '=='.
    const token = encodeSharingUrl('https://a.sharepoint.com/x');
    expect(token).not.toContain('=');
    expect(token).not.toContain('%3D');
  });

  it('encodes non-ASCII as UTF-8 bytes', () => {
    const token = encodeSharingUrl('https://svdp.sharepoint.com/Café Ñoño.xlsx');
    const b64 = token.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('Café Ñoño');
  });
});

// ── (B) the error mapping ───────────────────────────────────────────────────

describe('resolveSharingUrl — the 400 / 403 / 404 split', () => {
  // Built against the real client so the taxonomy under test is the one the
  // route actually catches, not a re-statement of it.
  async function client(status: number, body: unknown = {}) {
    vi.resetModules();
    vi.doMock('../access-token', () => ({
      acquireAccessToken: async () => 'test-token',
      DocIngestHaltedError: class extends Error {},
      DocIngestNotConnectedError: class extends Error {},
    }));
    const graphModule = await import('../graph');
    // Typed generically so `mock.calls[0]` is a real `[string, RequestInit?]`
    // tuple — the URL and headers are what the assertions are about.
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    return {
      graph: graphModule.docIngestGraph({} as never, { fetchImpl }),
      errors: graphModule,
      fetchImpl,
    };
  }

  const LINK = 'https://svdp.sharepoint.com/:x:/g/personal/docs_dr3_svdp_us/Ab12?e=xyz';

  it('403 → access denied (the share was never granted), NOT "not found"', async () => {
    const { graph, errors } = await client(403);
    await expect(graph.resolveSharingUrl(LINK)).rejects.toBeInstanceOf(
      errors.DocIngestAccessDeniedError,
    );
  });

  it('404 → not found (deleted / revoked), NOT "access denied"', async () => {
    const { graph, errors } = await client(404);
    await expect(graph.resolveSharingUrl(LINK)).rejects.toBeInstanceOf(
      errors.DocIngestNotFoundError,
    );
  });

  it('400 → a terminal sharing-URL error, never the transient Graph error', async () => {
    const { graph, errors } = await client(400);
    const err = await graph.resolveSharingUrl(LINK).catch((e: unknown) => e);
    // Terminal, because retrying a link Graph cannot parse produces nothing —
    // and DocIngestGraphError means "retried on the next sweep".
    expect(err).toBeInstanceOf(errors.DocIngestSharingUrlError);
    expect(err).not.toBeInstanceOf(errors.DocIngestGraphError);
  });

  it('refuses a non-Microsoft host WITHOUT spending a Graph call', async () => {
    const { graph, errors, fetchImpl } = await client(200);
    await expect(
      graph.resolveSharingUrl('https://drive.google.com/file/d/abc'),
    ).rejects.toBeInstanceOf(errors.DocIngestSharingUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hits /shares/u!{token}/driveItem and never sends Prefer: redeemSharingLink', async () => {
    const { graph, fetchImpl } = await client(200, {
      id: 'item-9',
      name: 'Attachment.xlsx',
      file: { mimeType: 'application/vnd.ms-excel' },
      parentReference: { driveId: 'drive-Z' },
      createdBy: { user: { email: 'kelsey@svdp.us' } },
    });

    const resolved = await graph.resolveSharingUrl(LINK);
    expect(resolved.id).toBe('item-9');
    expect(resolved.driveId).toBe('drive-Z');
    expect(resolved.createdByUpn).toBe('kelsey@svdp.us');

    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe(`https://graph.microsoft.com/v1.0/shares/${encodeSharingUrl(LINK)}/driveItem`);
    // `redeemSharingLink` grants DURABLE access — a permission change. This
    // integration is read-only and holds no write scope; sending it would be a
    // write performed by an accident of copy-paste.
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('prefer');
  });
});

// ── projection: the two owner facets kept apart ─────────────────────────────

describe('projectDriveItem — createdBy and shared.owner are recorded separately', () => {
  it('splits the facets, and never reads shared.sharedBy for either', () => {
    const projected = projectDriveItem({
      id: 'item-1',
      name: 'Log.xlsm',
      file: {},
      parentReference: { driveId: 'drive-A' },
      createdBy: { user: { email: 'kelsey@svdp.us' } },
      shared: {
        owner: { user: { email: 'morena@svdp.us' } },
        // The person who HANDED IT OVER. Not the owner, and it must not leak
        // into either column — the departure alert names the owner.
        sharedBy: { user: { email: 'intern@svdp.us' } },
      },
    });

    expect(projected?.createdByUpn).toBe('kelsey@svdp.us');
    expect(projected?.sharedOwnerUpn).toBe('morena@svdp.us');
    expect(projected?.ownerUpn).not.toBe('intern@svdp.us');
    expect(projected?.createdByUpn).not.toBe('intern@svdp.us');
    expect(projected?.sharedOwnerUpn).not.toBe('intern@svdp.us');
  });

  it('reports null (not undefined-ish noise) when a sharedWithMe stub carries neither', () => {
    // This IS the live shape: remoteItem has `shared.sharedBy` and nothing else.
    const projected = projectDriveItem({
      id: 'stub',
      remoteItem: {
        id: 'item-2',
        name: 'Shared.xlsm',
        file: {},
        parentReference: { driveId: 'drive-B' },
        shared: { sharedBy: { user: { email: 'intern@svdp.us' } } },
      },
    });
    expect(projected?.createdByUpn).toBeNull();
    expect(projected?.sharedOwnerUpn).toBeNull();
    expect(projected?.ownerUpn).toBeNull();
  });
});

// ── (A) owner enrichment ────────────────────────────────────────────────────

describe('owner enrichment on first discovery', () => {
  it('fills owner_upn from createdBy, which the shared-with-me stub never carries', async () => {
    // The stub, exactly as the live tenant returns it: no owner of any kind.
    const stub = item({ id: 'item-1', ownerUpn: null });
    const getItem = vi.fn(async () =>
      item({ id: 'item-1', createdByUpn: 'kelsey@svdp.us', sharedOwnerUpn: null }),
    );
    const graph = makeGraph({ listSharedWithMe: async () => [stub], getItem });

    const result = await runDiscovery(p(), graph, undefined, { now: NOW });

    expect(result.discovered).toBe(1);
    expect(getItem).toHaveBeenCalledWith('drive-A', 'item-1');
    // Without this, `reconcileMissing`'s owner buckets are all NULL and the
    // "everything Kelsey shared went dark at once" alert can never fire.
    expect(sources()[0]?.['owner_upn']).toBe('kelsey@svdp.us');
  });

  it('prefers createdBy over shared.owner — the alert names the author', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1' })],
      getItem: async () =>
        item({ id: 'item-1', createdByUpn: 'kelsey@svdp.us', sharedOwnerUpn: 'morena@svdp.us' }),
    });

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(sources()[0]?.['owner_upn']).toBe('kelsey@svdp.us');
  });

  it('falls back to shared.owner when there is no createdBy', async () => {
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1' })],
      getItem: async () =>
        item({ id: 'item-1', createdByUpn: null, sharedOwnerUpn: 'morena@svdp.us' }),
    });

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(sources()[0]?.['owner_upn']).toBe('morena@svdp.us');
  });

  it('does NOT spend the extra call on a folder', async () => {
    const getItem = vi.fn(async () => item({ id: 'folder-1' }));
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'folder-1', isFolder: true })],
      listChildren: async () => [],
      getItem,
    });

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(getItem).not.toHaveBeenCalled();
  });

  it('enriches on CREATE only — a re-seen source does not re-pay the call', async () => {
    const getItem = vi.fn(async () => item({ id: 'item-1', createdByUpn: 'kelsey@svdp.us' }));
    const graph = makeGraph({ listSharedWithMe: async () => [item({ id: 'item-1' })], getItem });

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(getItem).toHaveBeenCalledTimes(1);

    await runDiscovery(p(), graph, undefined, { now: NOW });
    // Still one: the second sweep saw an existing row and skipped enrichment.
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it('does not ERASE the enriched owner on the next sweep', async () => {
    // The defect this pins: `upsertSource`'s update branch wrote
    // `owner_upn: item.ownerUpn` unconditionally, and `item.ownerUpn` is NULL for
    // every source `sharedWithMe` returns. So the value enriched at creation was
    // blanked 15 minutes later, with no trace, and the feature was permanently
    // inert while every test of the CREATE path passed.
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', ownerUpn: null })],
      getItem: async () => item({ id: 'item-1', createdByUpn: 'kelsey@svdp.us' }),
    });

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(sources()[0]?.['owner_upn']).toBe('kelsey@svdp.us');

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(sources()[0]?.['owner_upn']).toBe('kelsey@svdp.us');
  });

  it('BACKFILLS a source that predates enrichment', async () => {
    // TEREX.xlsx is live right now with owner_upn NULL. Without a backfill it
    // stays NULL forever, because enrichment only ran on create.
    await prisma.docSource.create({
      data: {
        drive_id: 'drive-A',
        item_id: 'item-1',
        kind: 'file',
        display_name: 'TEREX.xlsx',
        owner_upn: null,
        state: 'active',
      },
    });

    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', ownerUpn: null })],
      getItem: async () => item({ id: 'item-1', createdByUpn: 'janette.tomas@svdp.us' }),
    });

    await runDiscovery(p(), graph, undefined, { now: NOW });
    expect(sources()[0]?.['owner_upn']).toBe('janette.tomas@svdp.us');
  });

  it('a FAILED enrichment does not fail discovery — the source is still created', async () => {
    // A 403 on the direct drive-item GET is entirely expected for a document
    // reachable only through a sharing link. Discovery must survive it.
    const graph = makeGraph({
      listSharedWithMe: async () => [item({ id: 'item-1', ownerUpn: null })],
      getItem: async () => {
        throw new Error('graph exploded');
      },
    });

    const result = await runDiscovery(p(), graph, undefined, { now: NOW });

    expect(result.discovered).toBe(1);
    expect(sources()).toHaveLength(1);
    expect(sources()[0]?.['owner_upn']).toBeNull();
    expect(sources()[0]?.['state']).toBe('active');
  });
});

// ── (B) registration through the discovery path ─────────────────────────────

describe('registerSharedItem — the operator path lands on the same row shape', () => {
  it('creates an active, unclassified source and reports created: true', async () => {
    const graph = makeGraph({
      getItem: async () => item({ id: 'item-9', createdByUpn: 'kelsey@svdp.us' }),
    });
    const resolved = item({
      id: 'item-9',
      driveId: 'drive-Z',
      name: 'Attachment.xlsx',
      webUrl: 'https://svdp.sharepoint.com/x',
    });

    const registered = await registerSharedItem(p(), graph, resolved, { now: NOW });

    expect(registered.created).toBe(true);
    expect(registered.displayName).toBe('Attachment.xlsx');
    expect(registered.ownerUpn).toBe('kelsey@svdp.us');
    const row = sources()[0];
    expect(row?.['state']).toBe('active');
    expect(row?.['enabled']).toBe(true);
    // NULL site = UNCLASSIFIED (hard rule #2) — it goes to the confirm queue
    // exactly like an auto-discovered file, not straight into ingestion.
    expect(row?.['site_id'] ?? null).toBeNull();
    expect(row?.['doc_class'] ?? null).toBeNull();
  });

  it('is idempotent — registering a known document reports created: false', async () => {
    const graph = makeGraph({ getItem: async () => item({ id: 'item-9' }) });
    const resolved = item({ id: 'item-9', driveId: 'drive-Z' });

    await registerSharedItem(p(), graph, resolved, { now: NOW });
    const second = await registerSharedItem(p(), graph, resolved, { now: NOW });

    expect(second.created).toBe(false);
    expect(sources()).toHaveLength(1);
  });

  it('does not demote a nested source to a root or wipe its dedup evidence', async () => {
    // Discover it as a child of a shared folder first…
    const folder = item({ id: 'folder-1', isFolder: true });
    const child = item({ id: 'item-1' });
    await runDiscovery(
      p(),
      makeGraph({
        listSharedWithMe: async () => [folder],
        listChildren: async () => [child],
        getItem: async () => item({ id: 'item-1' }),
      }),
      undefined,
      { now: NOW },
    );
    const before = sources().find((s) => s['item_id'] === 'item-1');
    expect(before?.['depth']).toBe(1);
    expect(before?.['parent_item_id']).toBe('folder-1');

    // …then register the same file by link.
    await registerSharedItem(p(), makeGraph(), child, { now: NOW });

    const after = sources().find((s) => s['item_id'] === 'item-1');
    // depth/parent are facts about how the document is REACHABLE. Flattening
    // them would be undone by the next sweep anyway; churn, not truth.
    expect(after?.['depth']).toBe(1);
    expect(after?.['parent_item_id']).toBe('folder-1');
  });
});
