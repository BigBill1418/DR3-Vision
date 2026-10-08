// @vitest-environment jsdom
//
// ADR-0140 Amendment 1 — the same-day count void (ADR-0084) had a bare `fetch`.
// A void into a dead link left "Yes, void it" disabled with no way back. It now
// fails on the 20 s deadline. There is deliberately no offline/queued branch for a
// void (see the component header): the count stands, the screen says the void did
// not go through, and the operator is back on the list to try again — where the
// server's idempotency key and `snapshot_not_found` answer make a retry of a void
// that actually landed harmless.
//
// FALSIFIED BY HAND: with the bare `fetch` restored, the waitFor below times out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

vi.mock('@/lib/offline-queue', () => ({ newIdempotencyKey: () => 'void-key-1' }));

vi.mock('@/lib/fetch-timeout', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/fetch-timeout')>();
  return {
    ...orig,
    fetchWithTimeout: (url: string, init?: RequestInit) => orig.fetchWithTimeout(url, init, 40),
  };
});

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { CountVoidClient } from './void-client';

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a count void that never answers', () => {
  it('fails on the deadline, returns to the list, and says the void did not go through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    render(
      <CountVoidClient
        siteCode="woodland"
        counts={[
          { id: 'snap-1', countedAtLabel: '9:12 AM', physicalTotal: 2483, enteredByLabel: null },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.floor.count.void_action }));
    fireEvent.click(screen.getByTestId('count-void-yes'));

    await waitFor(() => expect(screen.getByTestId('count-void-list')).toBeTruthy());
    expect(document.body.textContent).toContain(en.floor.common.save_failed);
    expect(
      screen.queryByTestId('count-void-done'),
      'a void the server never acked shown as done',
    ).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
