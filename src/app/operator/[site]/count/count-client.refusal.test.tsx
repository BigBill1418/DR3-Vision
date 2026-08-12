// @vitest-environment jsdom
//
// Audit D-8 — the ONLINE `date_not_today` refusal was a true silent no-op.
//
// ## The repro these tests encode
//
// An operator opens `/operator/woodland/count` at 23:50 PT, is called away, and
// enters the counts at 00:05 PT. `countDate` was rendered by the server before
// midnight, so it is now yesterday, and `assertCurrentPacificDay`
// (`route-helpers.ts:84-91`) answers 422 `date_not_today`. Before this change
// the screen said "Couldn't save. Try again." — and every retap earned the same
// 422, because nothing on the page could ever change the day it was rendered
// with. The offline replay of the SAME refusal has named it and offered a way
// out since ADR-0078 (`conflicts-client.tsx:168,250-259`); the live path never
// learned it.
//
// ## Why the assertions are on rendered TEXT
//
// Asserting "the wrong-day branch ran" is exactly what the broken version would
// also have passed, since it had a branch too — the generic one. What was wrong
// was the sentence an operator read, so that is what is measured, through the
// REAL dictionary and the REAL interpolation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { enqueueAction, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueAction: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueAction, isOfflineError, newIdempotencyKey }));

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

/** The single POST this screen makes, answered with `status` and `body`. */
function serverAnswers(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

/**
 * `priorTotal: null` is Tier 0 — no anchor, so Save posts straight through
 * rather than routing via the confirm screen. The refusal, not the guardrail,
 * is what is under test.
 */
function renderCount(): void {
  render(
    <CountClient
      siteCode="woodland"
      expectedTotal={2483}
      jurisdiction="oregon"
      priorTotal={null}
      thresholdPct={20}
      countDate="2026-08-11"
    />,
  );
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: en.floor.count.submit }));
}

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('422 date_not_today — the midnight-boundary save', () => {
  beforeEach(() => {
    serverAnswers(422, { error: 'date_not_today' });
    renderCount();
    save();
  });

  it('names the day as the reason instead of "Couldn\'t save. Try again."', async () => {
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.floor.conflicts.why_wrong_day);
    expect(
      document.body.textContent,
      'the generic sentence that produced the retap survived',
    ).not.toContain(en.floor.common.save_failed);
  });

  it('offers a control, and that control re-renders the page from the server', async () => {
    const reload = await screen.findByTestId('write-refusal-refresh');
    expect(reload.textContent).toBe(en.update_prompt.reload);
    fireEvent.click(reload);
    expect(refresh, 'the only way the stale countDate can become today').toHaveBeenCalledTimes(1);
    // And the banner clears, so the screen is not still accusing the operator of
    // a day mismatch they have just acted on.
    await waitFor(() => expect(screen.queryByTestId('write-refusal')).toBeNull());
  });

  it('does not present the refused count as saved or as queued', async () => {
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(screen.queryByTestId('count-queued')).toBeNull();
    expect(document.body.textContent).not.toContain(en.floor.count.result_heading);
    expect(
      enqueueAction,
      'a refused day must not be queued to replay into itself',
    ).not.toHaveBeenCalled();
  });
});

describe('401 — the session ended, not the network', () => {
  it('says the sign-in expired rather than inviting a retry', async () => {
    // `auth-helpers` answers a dead session with a bare text body, so the STATUS
    // is the only signal; the body here is deliberately reason-free.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthenticated', { status: 401 })),
    );
    renderCount();
    save();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.auth_login.error_session_expired);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
  });

  it('offers no reload — a new day is not what is wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthenticated', { status: 401 })),
    );
    renderCount();
    save();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(screen.queryByTestId('write-refusal-refresh')).toBeNull();
  });
});

describe('what the new branch must NOT swallow', () => {
  // Guard-the-guard. A classifier that captured every failure would make the
  // suite above pass while erasing every reason the screen already stated.
  it('a 500 is still the generic failure', async () => {
    serverAnswers(500, {});
    renderCount();
    save();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.common.save_failed));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('pool_mismatch keeps its own sentence', async () => {
    serverAnswers(422, { error: 'pool_mismatch' });
    renderCount();
    save();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.count.err_split));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('a Tier 2 hold is still a hold, not a refusal banner', async () => {
    serverAnswers(422, {
      error: 'manager_approval_required',
      holdId: 'hold-1',
      priorTotal: 2483,
      newTotal: 100,
      swingPct: 96,
      approvers: [{ id: 'u1', name: 'Rick' }],
    });
    renderCount();
    save();
    await waitFor(() => expect(screen.getByTestId('count-hold')).toBeTruthy());
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });
});
