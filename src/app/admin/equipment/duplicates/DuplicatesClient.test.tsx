// @vitest-environment jsdom
//
// ADR-0135 F — the "possible duplicates" queue client.
//
// Locks the two payloads the server contracts depend on:
//   - a CROSS-SITE merge must send `survivorSiteId` (a site id, or null for
//     fleet-wide) — without it the merge route answers 422 `cross_site`;
//   - "Different assets" must carry a real reason (≥ OVERRIDE_REASON_MIN).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DuplicatePair } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { DuplicatesClient } from './DuplicatesClient';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const SITES = [
  { id: 'site-eugene', code: 'eugene', name: 'DR3 Eugene' },
  { id: 'site-woodland', code: 'woodland', name: 'DR3 Woodland' },
];

function side(
  over: Partial<DuplicatePair['a']> & Pick<DuplicatePair['a'], 'id' | 'displayName'>,
): DuplicatePair['a'] {
  return {
    category: 'vehicle',
    siteId: 'site-eugene',
    siteCode: 'eugene',
    isActive: true,
    mergedIntoId: null,
    unitNumber: null,
    reason: 'same_unit',
    probableDuplicate: true,
    links: 0,
    ...over,
  };
}

const CROSS: DuplicatePair = {
  a: side({ id: 'eq-a', displayName: '281577 trailer', links: 1 }),
  b: side({
    id: 'eq-b',
    displayName: '281577 — Wabash Trailer',
    siteId: 'site-woodland',
    siteCode: 'woodland',
    links: 4,
  }),
  reason: 'same_unit',
  crossSite: true,
};

const SAME: DuplicatePair = {
  a: side({ id: 'eq-c', displayName: 'Terex', links: 7 }),
  b: side({ id: 'eq-d', displayName: 'terex', links: 2, isActive: false }),
  reason: 'same_name',
  crossSite: false,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, repointed: { links: 1, requests: 0, throughput: 2 } }),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  refresh.mockReset();
});

const lastBody = () =>
  JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const submit = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

describe('DuplicatesClient', () => {
  it('shows the empty state', () => {
    render(<DuplicatesClient pairs={[]} sites={SITES} />);
    expect(screen.getByTestId('admin-duplicates-empty').textContent).toBe(
      'No possible duplicates.',
    );
  });

  it('shows both rows with site, status, links and why they matched; flags cross-site', () => {
    render(<DuplicatesClient pairs={[CROSS]} sites={SITES} />);
    expect(screen.getByTestId('admin-duplicate-cross-site')).toBeTruthy();
    const a = screen.getByTestId('admin-duplicate-side-a').textContent ?? '';
    const b = screen.getByTestId('admin-duplicate-side-b').textContent ?? '';
    expect(a).toMatch(/281577 trailer/);
    expect(a).toMatch(/DR3 Eugene/);
    expect(a).toMatch(/1 AP link\b/);
    expect(b).toMatch(/DR3 Woodland/);
    expect(b).toMatch(/4 AP links/);
    expect(b).toMatch(/Active/);
    expect(screen.getByText(M.equipment.duplicatesReason.same_unit)).toBeTruthy();
  });

  it('renders a fleet-wide row as "Fleet-wide"', () => {
    const pair = { ...CROSS, a: { ...CROSS.a, siteId: null, siteCode: null } };
    render(<DuplicatesClient pairs={[pair]} sites={SITES} />);
    expect(screen.getByTestId('admin-duplicate-side-a').textContent).toMatch(/Fleet-wide/);
  });

  it('cross-site merge: blocks until a survivor site is chosen, then posts survivorSiteId', async () => {
    render(<DuplicatesClient pairs={[CROSS]} sites={SITES} />);
    click('admin-duplicate-merge-open');
    expect(submit('admin-duplicate-merge-submit').disabled).toBe(true);

    fireEvent.change(screen.getByTestId('admin-duplicate-survivor-site'), {
      target: { value: 'site-woodland' },
    });
    click('admin-duplicate-merge-submit');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/equipment/merge');
    // Default survivor = the row with more AP links (b: 4 vs a: 1).
    expect(lastBody()).toEqual({
      winnerId: 'eq-b',
      loserId: 'eq-a',
      survivorSiteId: 'site-woodland',
    });
    expect(window.confirm).toHaveBeenCalledWith(M.equipment.mergeConfirm);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByTestId('admin-duplicates-notice').textContent).toBe(
      M.equipment.mergeSuccess(3),
    );
  });

  it('cross-site merge to fleet-wide sends survivorSiteId: null, honouring a switched survivor', async () => {
    render(<DuplicatesClient pairs={[CROSS]} sites={SITES} />);
    click('admin-duplicate-merge-open');
    click('admin-duplicate-side-a-keep');
    fireEvent.change(screen.getByTestId('admin-duplicate-survivor-site'), {
      target: { value: '__fleet__' },
    });
    click('admin-duplicate-merge-submit');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ winnerId: 'eq-a', loserId: 'eq-b', survivorSiteId: null });
  });

  it('same-site merge sends no survivorSiteId', async () => {
    render(<DuplicatesClient pairs={[SAME]} sites={SITES} />);
    click('admin-duplicate-merge-open');
    expect(screen.queryByTestId('admin-duplicate-survivor-site')).toBeNull();
    click('admin-duplicate-merge-submit');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ winnerId: 'eq-c', loserId: 'eq-d' });
  });

  it('a declined confirm posts nothing', () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<DuplicatesClient pairs={[SAME]} sites={SITES} />);
    click('admin-duplicate-merge-open');
    click('admin-duplicate-merge-submit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server error (e.g. throughput conflict) and does not refresh', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Both machines logged throughput on 2026-09-01.', code: 'x' }),
    });
    render(<DuplicatesClient pairs={[SAME]} sites={SITES} />);
    click('admin-duplicate-merge-open');
    click('admin-duplicate-merge-submit');
    expect((await screen.findByTestId('admin-duplicate-error')).textContent).toBe(
      'Both machines logged throughput on 2026-09-01.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('"Different assets" requires a reason of at least OVERRIDE_REASON_MIN characters', async () => {
    render(<DuplicatesClient pairs={[SAME]} sites={SITES} />);
    click('admin-duplicate-distinct-open');
    expect(submit('admin-duplicate-distinct-submit').disabled).toBe(true);

    fireEvent.change(screen.getByTestId('admin-duplicate-distinct-reason'), {
      target: { value: 'different' }, // 9 chars
    });
    expect(submit('admin-duplicate-distinct-submit').disabled).toBe(true);
    click('admin-duplicate-distinct-submit');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('admin-duplicate-distinct-reason'), {
      target: { value: '  different VIN, two machines  ' },
    });
    expect(submit('admin-duplicate-distinct-submit').disabled).toBe(false);
    click('admin-duplicate-distinct-submit');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/equipment/duplicates');
    expect(lastBody()).toEqual({ aId: 'eq-c', bId: 'eq-d', reason: 'different VIN, two machines' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
