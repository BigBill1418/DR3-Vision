// @vitest-environment jsdom
//
// ADR-0135 A — the resolve panel is SEARCH-FIRST.
//
// 23 of the first 27 resolutions created a row, most for assets already in the
// registry, because the only primary button was "Add to the fleet". The primary
// action is now "Find it in the fleet"; "Use this one" posts the EXISTING-asset
// resolve (`equipmentId`), and adding a new asset is the secondary path.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EquipmentRequestsClient,
  initialSearch,
  type EquipmentRequestRow,
} from './EquipmentRequestsClient';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITES = [
  { id: 'site-eugene', code: 'eugene', name: 'DR3 Eugene' },
  { id: 'site-woodland', code: 'woodland', name: 'DR3 Woodland' },
];

const REQUEST: EquipmentRequestRow = {
  id: 'req-1',
  description: 'Unit #: 5327\nType: Trailer\nMake: Great Dane',
  status: 'open',
  requestedAt: '2026-09-20T17:00:00.000Z',
  requesterName: 'Pat',
  siteId: 'site-eugene',
  siteCode: 'eugene',
  siteName: 'DR3 Eugene',
  apRequestId: 'ap-1',
  subject: 'Invoice 42',
  vendor: 'Tire Shop',
  amountCents: 12345,
  resolvedEquipmentId: null,
  resolvedEquipmentName: null,
  resolverName: null,
  resolvedAt: null,
  resolutionNote: null,
  linkPending: true,
  structured: { assetType: 'trailer', unitNumber: '5327', make: 'Great Dane', notes: '' },
};

const HITS = [
  {
    id: 'eq-live',
    displayName: '5327 — Great Dane Trailer',
    category: 'vehicle',
    siteCode: 'woodland',
    isActive: true,
    mergedIntoId: null,
  },
  {
    id: 'eq-fleet-inactive',
    displayName: 'Trailer 5327',
    category: 'vehicle',
    siteCode: null,
    isActive: false,
    mergedIntoId: null,
  },
  {
    id: 'eq-merged',
    displayName: 'trailer 5327.',
    category: 'vehicle',
    siteCode: 'eugene',
    isActive: false,
    mergedIntoId: 'eq-live',
  },
];

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  // The pure `initialSearch` tests mount nothing.
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
});

function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const r = createRoot(el);
  container = el;
  root = r;
  act(() => r.render(node));
}

const q = <T extends HTMLElement>(testid: string) =>
  container!.querySelector(`[data-testid="${testid}"]`) as T | null;

async function click(testid: string) {
  await act(async () => {
    q(testid)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });

/** Routes GETs to the fleet search and POSTs to the resolve endpoint. */
function routedFetch(hits = HITS) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return { ok: true, status: 200, json: async () => ({ existing: hits }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, status: 'resolved' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (fetchMock: ReturnType<typeof routedFetch>) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));

describe('initialSearch', () => {
  it('a structured request searches for its unit number and type label', () => {
    expect(initialSearch(REQUEST)).toBe('5327 Trailer');
  });

  it('a structured request with no unit number falls back to the make', () => {
    expect(
      initialSearch({
        description: '',
        structured: { assetType: 'baler', unitNumber: '', make: 'Harris', notes: '' },
      }),
    ).toBe('Harris Baler');
  });

  it('a legacy name-like description is used as-is', () => {
    expect(initialSearch({ description: 'trailer 540010', structured: null })).toBe(
      'trailer 540010',
    );
  });

  it('a legacy multi-unit work order searches for EVERY unit, not nothing', () => {
    expect(
      initialSearch({
        description: 'Fix and repair trailer: 53489, 5340, 35, 282859 going to Oregon Stores',
        structured: null,
      }),
    ).toBe('53489 5340 35 282859');
  });
});

describe('search-first resolve panel', () => {
  it('the primary action is "Find it in the fleet" — there is no create button up front', () => {
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    expect(q('equipment-request-find')!.textContent).toBe('Find it in the fleet');
    expect(q('admin-equipment-create-submit')).toBeNull();
  });

  it('searches the whole fleet (search=1) pre-filled from the request, and ranks as returned', async () => {
    const fetchMock = routedFetch();
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();

    expect(q<HTMLInputElement>('equipment-request-search-input')!.value).toBe('5327 Trailer');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('/api/admin/equipment/similar?search=1&q=5327%20Trailer');

    const items = [...container!.querySelectorAll('[data-testid^="equipment-request-result-"]')];
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual([
      'equipment-request-result-eq-live',
      'equipment-request-result-eq-fleet-inactive',
    ]);
    // Site code, or "fleet" for a fleet-wide asset.
    expect(q('equipment-request-result-eq-live')!.textContent).toContain('woodland');
    expect(q('equipment-request-result-eq-fleet-inactive')!.textContent).toContain('fleet');
  });

  it('never offers a merged-away row', async () => {
    routedFetch();
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    expect(q('equipment-request-result-eq-merged')).toBeNull();
    expect(q('equipment-request-use-eq-merged')).toBeNull();
  });

  it('"Use this one" posts the EXISTING-asset resolve with equipmentId and the backfill flag', async () => {
    const fetchMock = routedFetch();
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    await click('equipment-request-use-eq-live');

    expect(posts(fetchMock)).toEqual([
      {
        url: '/api/admin/ap/equipment-requests/req-1',
        body: { action: 'resolve', equipmentId: 'eq-live', backfillLink: true },
      },
    ]);
    expect(refresh).toHaveBeenCalled();
  });

  it('an INACTIVE hit reads "Reactivate and use" and sends reactivate: true', async () => {
    const fetchMock = routedFetch();
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    expect(q('equipment-request-use-eq-fleet-inactive')!.textContent).toBe('Reactivate and use');

    await click('equipment-request-backfill');
    await click('equipment-request-use-eq-fleet-inactive');
    expect(posts(fetchMock)[0]?.body).toEqual({
      action: 'resolve',
      equipmentId: 'eq-fleet-inactive',
      backfillLink: false,
      reactivate: true,
    });
  });

  it('shows the server refusal and stays open when the resolve fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }
          : { ok: true, status: 200, json: async () => ({ existing: HITS }) },
      ),
    );
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    await click('equipment-request-use-eq-live');
    expect(container!.querySelector('[role="alert"]')!.textContent).toBe('forbidden');
    expect(q('equipment-request-search')).not.toBeNull();
  });

  it('says so when nothing matches', async () => {
    routedFetch([]);
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    expect(q('equipment-request-no-matches')).not.toBeNull();
  });

  it('"Add a new asset instead" opens the structured form pre-filled from the request', async () => {
    routedFetch();
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    await click('equipment-request-add-new');

    expect(q<HTMLSelectElement>('admin-equipment-create-type')!.value).toBe('trailer');
    expect(q<HTMLInputElement>('admin-equipment-create-unit')!.value).toBe('5327');
    expect(q<HTMLInputElement>('admin-equipment-create-make')!.value).toBe('Great Dane');
    expect(q<HTMLSelectElement>('admin-equipment-create-site')!.value).toBe('site-eugene');
    expect(q('admin-equipment-create-preview')!.textContent).toContain('5327 — Great Dane Trailer');
  });

  it('the new-asset form posts the structured resolve to the request endpoint', async () => {
    const fetchMock = routedFetch([]);
    mount(<EquipmentRequestsClient requests={[REQUEST]} sites={SITES} />);
    await click('equipment-request-find');
    await settle();
    await click('equipment-request-add-new');
    await click('admin-equipment-create-submit');

    expect(posts(fetchMock).at(-1)).toEqual({
      url: '/api/admin/ap/equipment-requests/req-1',
      body: {
        siteId: 'site-eugene',
        assetType: 'trailer',
        unitNumber: '5327',
        make: 'Great Dane',
        action: 'resolve',
        backfillLink: true,
      },
    });
  });
});

describe('resolved wording', () => {
  it('says "Resolved to" — the asset may have existed already', () => {
    mount(
      <EquipmentRequestsClient
        requests={[
          {
            ...REQUEST,
            status: 'resolved',
            resolvedEquipmentId: 'eq-live',
            resolvedEquipmentName: '5327 — Great Dane Trailer',
            resolverName: 'Bill',
            linkPending: false,
          },
        ]}
        sites={SITES}
      />,
    );
    const text = q('equipment-request-resolved')!.textContent ?? '';
    expect(text).toContain('Resolved to 5327 — Great Dane Trailer by Bill');
    expect(text).not.toContain('Added as');
    expect(q('equipment-request-find')).toBeNull();
  });
});
