// @vitest-environment jsdom
//
// Audit D-8 / D-7, `/dropoff` — the worst of the four, because it did not parse
// the response body at all:
//
//     if (!res.ok) { setStatus('error'); setError(t('floor.common.save_failed')); return; }
//
// so `date_not_today`, `invalid_input` and a 500 were literally the same event
// to this screen. Parsing the body is the precondition for classifying anything,
// and it is why this file tests a *reason* the other three could at least in
// principle have distinguished before.
//
// The 401 case has a second half here that the other three do not: the drop-off
// is a three-request flow, and a dead session is discovered at the FIRST one
// (the presigned-URL mint), before any bytes move. That refusal must not be
// queued — the drain runs behind the same expired session, and "Saved on this
// iPad — will send when you reconnect" over a row that cannot send is the false
// confirmation ADR-0078 exists to prevent.
//
// See `count-client.refusal.test.tsx` for the shared repro.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { enqueueDropoff, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueDropoff: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueDropoff, isOfflineError, newIdempotencyKey }));

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

import { DropoffClient } from './dropoff-client';

const MINT_OK = { storage_key: 'dropoffs/woodland/x.jpg', upload_url: null as string | null };

/**
 * The mint (request 1) succeeds with no `upload_url` — the R2-unconfigured
 * shape the component already supports — so request 2 is skipped and the NEXT
 * fetch is the drop-off write itself, answered with `status`/`body`.
 */
function writeAnswers(status: number, body: unknown = {}): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      call += 1;
      if (call === 1)
        return new Response(JSON.stringify(MINT_OK), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** The mint itself answers `status` — the session died before any bytes moved. */
function mintAnswers(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unauthenticated', { status })),
  );
}

function renderDropoff(): void {
  render(<DropoffClient siteCode="woodland" dropoffDate="2026-08-11" />);
}

/** Label → photo → send, in JT's order. Send is disabled until all three. */
function capture(): void {
  fireEvent.click(screen.getByRole('button', { name: en.floor.dropoff.kind_floor_public }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['jpeg-bytes'], 'IMG_0002.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(screen.getByTestId('dropoff-send'));
}

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('422 date_not_today — a body this screen never used to read', () => {
  it('names the day, and not the generic failure', async () => {
    writeAnswers(422, { error: 'date_not_today' });
    renderDropoff();
    capture();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.floor.conflicts.why_wrong_day);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
  });

  it('offers a reload that re-renders dropoffDate from the server', async () => {
    writeAnswers(422, { error: 'date_not_today' });
    renderDropoff();
    capture();
    const reload = await screen.findByTestId('write-refusal-refresh');
    expect(reload.textContent).toBe(en.update_prompt.reload);
    fireEvent.click(reload);
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('write-refusal')).toBeNull());
  });

  it('is never rendered as sent or as queued', async () => {
    writeAnswers(422, { error: 'date_not_today' });
    renderDropoff();
    capture();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).not.toContain(en.floor.common.saved);
    expect(document.body.textContent).not.toContain(en.floor.common.queued);
    expect(enqueueDropoff).not.toHaveBeenCalled();
  });
});

describe('401 at the mint — the session ended before any bytes moved', () => {
  it('says the sign-in expired rather than "Couldn\'t save. Try again."', async () => {
    mintAnswers(401);
    renderDropoff();
    capture();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.auth_login.error_session_expired);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
    expect(screen.queryByTestId('write-refusal-refresh')).toBeNull();
  });

  it('does not queue a drop-off that would drain behind the same dead session', async () => {
    mintAnswers(401);
    renderDropoff();
    capture();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(enqueueDropoff).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(en.floor.common.queued);
  });
});

describe('401 at the write', () => {
  it('is classified there too, not only at the mint', async () => {
    writeAnswers(401, {});
    renderDropoff();
    capture();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.auth_login.error_session_expired);
  });
});

describe('what the new branch must NOT swallow', () => {
  it('a 500 from the write is still the generic failure', async () => {
    writeAnswers(500, {});
    renderDropoff();
    capture();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.common.save_failed));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('a 500 from the mint is still the generic failure', async () => {
    mintAnswers(500);
    renderDropoff();
    capture();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.common.save_failed));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('an offline failure still queues, exactly as before', async () => {
    isOfflineError.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderDropoff();
    capture();
    await waitFor(() => expect(enqueueDropoff).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).toContain(en.floor.common.queued);
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });
});
