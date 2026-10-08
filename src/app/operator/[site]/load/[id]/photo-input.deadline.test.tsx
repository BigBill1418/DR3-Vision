// @vitest-environment jsdom
//
// ADR-0140 Amendment 1 — the live load-photo flow (mint → R2 PUT → confirm) had a
// bare `fetch` at every step, so one request into a dead link left the capture
// spinning with the photo held only in memory. Each step now fails on a deadline
// (20 s JSON, 90 s PUT) and a timeout is handled exactly like the device being
// offline: the bytes are queued under the key minted at the tap, and the stage
// advances, as it already does offline.
//
// FALSIFIED BY HAND: with the bare `fetch` restored at any one step, that case
// never settles and its waitFor times out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { enqueueUpload, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueUpload: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueUpload, isOfflineError, newIdempotencyKey }));

// Deadline shortened to 40 ms so a hung request is abandoned inside the test's
// own timeout; the abort/timeout mechanics are the real ones.
vi.mock('@/lib/fetch-timeout', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/fetch-timeout')>();
  return {
    ...orig,
    fetchWithTimeout: (url: string, init?: RequestInit) => orig.fetchWithTimeout(url, init, 40),
  };
});

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { PhotoInput } from './photo-input';

const onCaptured = vi.fn();

function shoot(): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['jpeg-bytes'], 'IMG_0001.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
}

function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });
}

const json200 = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const MINTED = { storage_key: 'loads/load-1/x.jpg', upload_url: 'https://r2/put' };

/** Answer every step promptly except `hang`, which never answers. */
function hangAt(hang: 'mint' | 'put' | 'confirm'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const step = url.includes('/upload-url')
        ? 'mint'
        : url.startsWith('https://r2/')
          ? 'put'
          : 'confirm';
      if (step === hang) return neverAnswers(init);
      if (step === 'mint') return Promise.resolve(json200(MINTED));
      if (step === 'put') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(json200({ id: 'photo-1' }));
    }),
  );
}

type Queued = { storage_key: string | null; upload_url: string | null; idempotency_key: string };
const queuedArg = (): Queued | undefined =>
  (enqueueUpload.mock.calls as unknown as Array<[Queued]>)[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a load-photo request that never answers', () => {
  it.each([
    ['mint', null, null],
    ['put', MINTED.storage_key, MINTED.upload_url],
    ['confirm', null, null],
  ] as const)(
    'a hung %s is queued under the tap key and the stage advances',
    async (step, storageKey, uploadUrl) => {
      hangAt(step);
      render(
        <PhotoInput
          loadId="load-1"
          kind="rejection"
          labelKey="rejection"
          onCaptured={onCaptured}
        />,
      );
      shoot();
      await waitFor(() => expect(enqueueUpload).toHaveBeenCalledTimes(1));
      const arg = queuedArg();
      expect(arg?.storage_key).toBe(storageKey);
      expect(arg?.upload_url).toBe(uploadUrl);
      expect(arg?.idempotency_key).toBe('0000000000abc-0000000000000000key1');
      await waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));
      // A timeout is not an error the operator must act on.
      expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
    },
  );
});
