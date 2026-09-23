// @vitest-environment jsdom
//
// ADR-0135 F — cross-site merge. Every live row is a candidate survivor; when the
// two sit at different yards (or one is fleet-wide) the admin must choose where
// the survivor lives, sent as `survivorSiteId` (a site id, or null = fleet-wide).
// A throughput conflict is rendered from the server's own sentence.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MergePanel, type MergeRow } from './MergePanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITES = [
  { id: 'site-eugene', code: 'eugene', name: 'DR3 Eugene' },
  { id: 'site-woodland', code: 'woodland', name: 'DR3 Woodland' },
];

const row = (id: string, site: 'eugene' | 'woodland' | null, name = id): MergeRow => ({
  id,
  display_name: name,
  site_id: site ? `site-${site}` : null,
  site_code: site,
  link_count: 1,
  resolved_request_count: 0,
});

const LOSER = row('loser', 'eugene', '281577 — Trailer');
const CANDIDATES = [
  row('same-yard', 'eugene', '281577 — Wabash Trailer'),
  row('other-yard', 'woodland', '281577 — Great Dane Trailer'),
  row('fleet', null, '9999 — Fleet Trailer'),
];

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

const q = <T extends HTMLElement>(testid: string) =>
  container.querySelector(`[data-testid="${testid}"]`) as T | null;

function select(testid: string, value: string) {
  const el = q<HTMLSelectElement>(testid)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function type(testid: string, value: string) {
  const el = q<HTMLInputElement>(testid)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(testid: string) {
  await act(async () => {
    q(testid)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function mergeFetch(response: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

const OK = {
  ok: true,
  status: 200,
  body: { ok: true, repointed: { links: 3, requests: 1, throughput: 2, gapAlerts: 0 } },
};

describe('MergePanel', () => {
  it('offers survivors at EVERY yard and fleet-wide, labelled with where they live', () => {
    mount(<MergePanel loser={LOSER} candidates={CANDIDATES} sites={SITES} onMerged={vi.fn()} />);
    const options = [...q<HTMLSelectElement>('admin-equipment-merge-winner-loser')!.options].map(
      (o) => o.textContent ?? '',
    );
    expect(options.some((o) => o.includes('Great Dane') && o.includes('woodland'))).toBe(true);
    expect(options.some((o) => o.includes('Fleet Trailer') && o.includes('Fleet-wide'))).toBe(true);
  });

  it('a same-yard merge sends no survivorSiteId', async () => {
    const fetchMock = mergeFetch(OK);
    const onMerged = vi.fn();
    mount(<MergePanel loser={LOSER} candidates={CANDIDATES} sites={SITES} onMerged={onMerged} />);
    select('admin-equipment-merge-winner-loser', 'same-yard');
    expect(q('admin-equipment-merge-site-loser')).toBeNull();
    await click('admin-equipment-merge-submit-loser');
    expect(sent(fetchMock)).toEqual({ winnerId: 'same-yard', loserId: 'loser' });
    // Every repointed table counts, throughput included.
    expect(onMerged).toHaveBeenCalledWith(6);
  });

  it('a cross-yard merge REQUIRES the survivor site and sends it', async () => {
    const fetchMock = mergeFetch(OK);
    mount(<MergePanel loser={LOSER} candidates={CANDIDATES} sites={SITES} onMerged={vi.fn()} />);
    select('admin-equipment-merge-winner-loser', 'other-yard');

    expect(q('admin-equipment-merge-site-loser')).not.toBeNull();
    expect(q<HTMLButtonElement>('admin-equipment-merge-submit-loser')!.disabled).toBe(true);

    select('admin-equipment-merge-site-loser', 'site-woodland');
    await click('admin-equipment-merge-submit-loser');
    expect(sent(fetchMock)).toEqual({
      winnerId: 'other-yard',
      loserId: 'loser',
      survivorSiteId: 'site-woodland',
    });
  });

  it('choosing Fleet-wide sends survivorSiteId null', async () => {
    const fetchMock = mergeFetch(OK);
    mount(<MergePanel loser={LOSER} candidates={CANDIDATES} sites={SITES} onMerged={vi.fn()} />);
    select('admin-equipment-merge-winner-loser', 'fleet');
    select('admin-equipment-merge-site-loser', 'fleet');
    await click('admin-equipment-merge-submit-loser');
    expect(sent(fetchMock)).toEqual({ winnerId: 'fleet', loserId: 'loser', survivorSiteId: null });
  });

  it('renders a throughput conflict from the server and does not report success', async () => {
    const error =
      'Both machines logged throughput on 2026-09-01. Void the wrong reading on one of them first, then merge.';
    mergeFetch({
      ok: false,
      status: 409,
      body: { error, code: 'throughput_conflict', conflictDates: ['2026-09-01'] },
    });
    const onMerged = vi.fn();
    mount(<MergePanel loser={LOSER} candidates={CANDIDATES} sites={SITES} onMerged={onMerged} />);
    select('admin-equipment-merge-winner-loser', 'same-yard');
    await click('admin-equipment-merge-submit-loser');
    expect(q('admin-equipment-merge-error-loser')!.textContent).toBe(error);
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('previews throughput days and gap alerts when the full counts are supplied', () => {
    mount(
      <MergePanel
        loser={LOSER}
        candidates={CANDIDATES}
        sites={SITES}
        counts={{ links: 2, requests: 1, throughput: 14, gapAlerts: 1 }}
        onMerged={vi.fn()}
      />,
    );
    const text = q('admin-equipment-merge-counts-loser')!.textContent ?? '';
    expect(text).toContain('14 throughput days');
    expect(text).toContain('1 gap alert');
  });

  it('filters the survivor list by unit number', () => {
    mount(<MergePanel loser={LOSER} candidates={CANDIDATES} sites={SITES} onMerged={vi.fn()} />);
    type('admin-equipment-merge-filter-loser', '9999');
    const values = [...q<HTMLSelectElement>('admin-equipment-merge-winner-loser')!.options].map(
      (o) => o.value,
    );
    expect(values).toEqual(['', 'fleet']);
  });
});
