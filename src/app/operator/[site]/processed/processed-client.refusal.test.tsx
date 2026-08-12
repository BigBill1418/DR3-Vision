// @vitest-environment jsdom
//
// Audit D-8, `/processed`. `processed-client.tsx` mapped exactly one reason —
// `closed` — so the ADR-0065 day pin (422 `date_not_today`) and an expired
// session (401) both landed on `floor.common.save_failed`: "Couldn't save. Try
// again." Neither can be cleared by trying again, which is what made the
// sentence a dead end rather than merely a vague one.
//
// See `count-client.refusal.test.tsx` for the shared repro and for why these
// assertions are on rendered text.

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

import { ProcessedClient } from './processed-client';

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

function renderProcessed(): void {
  render(
    <ProcessedClient
      siteCode="woodland"
      productionDate="2026-08-11"
      initialProgram={120}
      initialNonProgram={40}
      closed={false}
    />,
  );
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: en.floor.processed.submit }));
}

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('422 date_not_today', () => {
  it('names the day, and not the generic failure', async () => {
    serverAnswers(422, { error: 'date_not_today' });
    renderProcessed();
    save();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.floor.conflicts.why_wrong_day);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
  });

  it('offers a reload that re-renders productionDate from the server', async () => {
    serverAnswers(422, { error: 'date_not_today' });
    renderProcessed();
    save();
    const reload = await screen.findByTestId('write-refusal-refresh');
    expect(reload.textContent).toBe(en.update_prompt.reload);
    fireEvent.click(reload);
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('write-refusal')).toBeNull());
  });

  it('is never rendered as Saved', async () => {
    serverAnswers(422, { error: 'date_not_today' });
    renderProcessed();
    save();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).not.toContain(en.floor.common.saved);
    expect(screen.queryByTestId('processed-queued')).toBeNull();
  });
});

describe('401', () => {
  it('says the sign-in expired, with no reload on offer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthenticated', { status: 401 })),
    );
    renderProcessed();
    save();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.auth_login.error_session_expired);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
    expect(screen.queryByTestId('write-refusal-refresh')).toBeNull();
  });
});

describe('what the new branch must NOT swallow', () => {
  it('`closed` keeps its own sentence', async () => {
    serverAnswers(409, { error: 'closed' });
    renderProcessed();
    save();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.processed.err_closed));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('a 500 is still the generic failure', async () => {
    serverAnswers(500, {});
    renderProcessed();
    save();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.common.save_failed));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });
});
