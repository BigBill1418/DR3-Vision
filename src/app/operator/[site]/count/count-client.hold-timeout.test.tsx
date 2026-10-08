// @vitest-environment jsdom
//
// ADR-0140 Amendment 1, review F1 — a hold Approve/Discard that got NO ANSWER.
//
// Neither action is queued (a manager's PIN never goes to IndexedDB), so the
// 20 s deadline used to land on "Couldn't save. Try again." even when the release
// had landed and only its answer was lost: stale floor number, and a retry that
// re-asked for the manager's PIN only to be told to enter the count again.
//
// Now the screen reads the hold's status (GET, read-only) and lands where the
// server says. Every test also proves the write is NEVER resent.
//
// FALSIFIED BY HAND: with the old `catch { setError(save_failed) }` restored, the
// "landed" tests fail (no result, no refresh, save_failed shown).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { enqueueAction, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueAction: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueAction, isOfflineError, newIdempotencyKey }));

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

import { CountClient } from './count-client';

const HOLD_URL = '/api/operator/woodland/count/holds/hold-1';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });
}

/**
 * The count POST answers with a Tier 2 hold; the hold write (POST/DELETE) never
 * answers; the status read answers with `read` (or never, when null).
 */
function server(read: ((init?: RequestInit) => Promise<Response>) | null) {
  const f = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (url === '/api/operator/woodland/count') {
      return json(422, {
        error: 'manager_approval_required',
        holdId: 'hold-1',
        priorTotal: 2483,
        newTotal: 100,
        swingPct: 96,
        approvers: [{ id: 'u-mgr', name: 'Manager' }],
      });
    }
    if (url === HOLD_URL && (method === 'POST' || method === 'DELETE')) return neverAnswers(init);
    if (url === HOLD_URL && method === 'GET') return read ? read(init) : neverAnswers(init);
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}

function writes(f: ReturnType<typeof server>): number {
  return f.mock.calls.filter(
    ([u, i]) => u === HOLD_URL && (i?.method === 'POST' || i?.method === 'DELETE'),
  ).length;
}

async function toHold(): Promise<void> {
  render(
    <CountClient
      siteCode="woodland"
      expectedTotal={2483}
      jurisdiction="oregon"
      priorTotal={null}
      thresholdPct={20}
      countDate="2026-10-07"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: en.floor.count.submit }));
  await waitFor(() => expect(screen.getByTestId('count-hold')).toBeTruthy());
}

async function approve(): Promise<void> {
  await toHold();
  fireEvent.change(screen.getByTestId('hold-approver'), { target: { value: 'u-mgr' } });
  fireEvent.change(screen.getByTestId('hold-pin'), { target: { value: '1234' } });
  fireEvent.click(screen.getByTestId('hold-approve'));
}

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Approve times out', () => {
  it('and the release LANDED: shows the saved result and refreshes, without resending', async () => {
    const f = server(async () => json(200, { status: 'approved' }));
    await approve();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.count.result_heading));
    expect(refresh).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
    expect(writes(f), 'the release was resent').toBe(1);
  });

  it('and the hold is still pending: stays on the hold and says so', async () => {
    const f = server(async () => json(200, { status: 'pending' }));
    await approve();
    await waitFor(() =>
      expect(document.body.textContent).toContain(en.floor.count.hold_timeout_pending),
    );
    expect(screen.getByTestId('count-hold')).toBeTruthy();
    expect(writes(f)).toBe(1);
  });

  it('and someone else resolved it: the D-9 landing, not a stale hold', async () => {
    server(async () => json(404, { error: 'hold_not_found' }));
    await approve();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.count.hold_gone));
    expect(screen.queryByTestId('count-hold')).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('and the status cannot be read either: "may have gone through", refreshed', async () => {
    const f = server(null);
    await approve();
    await waitFor(() =>
      expect(document.body.textContent).toContain(en.floor.count.hold_timeout_unknown),
    );
    expect(refresh).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
    expect(writes(f)).toBe(1);
  });
});

describe('Discard times out', () => {
  it('and the discard LANDED: shows discarded, without resending', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('typo');
    const f = server(async () => json(200, { status: 'discarded' }));
    await toHold();
    fireEvent.click(screen.getByRole('button', { name: en.floor.count.hold_discard }));
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.count.hold_discarded));
    expect(writes(f)).toBe(1);
  });
});
