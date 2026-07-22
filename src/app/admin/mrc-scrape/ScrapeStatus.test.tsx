// @vitest-environment jsdom
//
// ADR-0057 — the MRC-Scrape status panel. Verifies it fetches the status API on
// mount and renders: an honest "no sync has run yet" empty state (never a fake
// healthy), the credential-unset hint, and — when configured with a prior run —
// the credential line, run status, and per-object mirror counts. The password is
// never part of the API payload, so there is nothing to leak here; the tests
// assert the rendered surface stays free of any password text regardless.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScrapeStatus } from './ScrapeStatus';
import type { MrcScrapeStatusResponse } from '@/app/api/admin/mrc-scrape/status/route';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const NEVER_RUN: MrcScrapeStatusResponse = {
  credential: { configured: false, username: null, updatedAt: null, updatedBy: null },
  lastRun: null,
  neverRun: true,
  objectCounts: [
    { object: 'hauls', count: 0, lastSeenAt: null },
    { object: 'processed', count: 0, lastSeenAt: null },
    { object: 'outbound', count: 0, lastSeenAt: null },
  ],
};

const CONFIGURED: MrcScrapeStatusResponse = {
  credential: {
    configured: true,
    username: 'bill@dr3',
    updatedAt: '2026-07-20T10:00:00.000Z',
    updatedBy: 'admin-1',
  },
  lastRun: {
    status: 'ok',
    feed: 'hauls',
    siteId: 'eugene',
    startedAt: '2026-07-21T09:00:00.000Z',
    finishedAt: '2026-07-21T09:02:00.000Z',
    rowsListed: 12,
    rowsUpserted: 12,
    detailsFetched: 12,
    error: null,
  },
  neverRun: false,
  objectCounts: [
    { object: 'hauls', count: 12, lastSeenAt: '2026-07-21T09:02:00.000Z' },
    { object: 'processed', count: 5, lastSeenAt: '2026-07-21T08:00:00.000Z' },
    { object: 'outbound', count: 0, lastSeenAt: null },
  ],
};

function mockFetch(body: MrcScrapeStatusResponse): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

// Render, then flush the mount-effect fetch + its resolved-promise microtasks.
async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ScrapeStatus />);
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ScrapeStatus', () => {
  it('renders the honest never-run empty state (not a fake healthy)', async () => {
    mockFetch(NEVER_RUN);
    await mount();

    const emptyState = container.querySelector('[data-testid="scrape-status-never-run"]');
    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain('No sync has run yet');
    // Nothing implies success anywhere on the panel.
    expect(container.textContent).not.toContain('OK');
    // Credential is shown as not configured, with the enable hint.
    expect(container.textContent).toContain('Not configured');
    expect(container.textContent).toContain('enable the first pull');
  });

  it('renders credential line, run status, and per-object counts when configured', async () => {
    mockFetch(CONFIGURED);
    await mount();

    expect(container.textContent).toContain('Configured');
    expect(container.textContent).toContain('bill@dr3');
    expect(container.querySelector('[data-testid="scrape-status-never-run"]')).toBeNull();

    // Run status pill + row counts.
    expect(container.textContent).toContain('OK');
    expect(container.textContent).toContain('12 listed');

    // One tile per existing mirror object.
    expect(container.querySelector('[data-testid="scrape-object-hauls"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="scrape-object-processed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="scrape-object-outbound"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="scrape-object-outbound"]')?.textContent).toContain(
      'no rows yet',
    );
  });

  it('never renders any password text', async () => {
    mockFetch(CONFIGURED);
    await mount();
    expect(container.textContent?.toLowerCase()).not.toContain('password');
  });

  it('fetches the status API exactly once on mount', async () => {
    mockFetch(CONFIGURED);
    await mount();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/admin/mrc-scrape/status',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
