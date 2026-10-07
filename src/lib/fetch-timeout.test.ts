// A request into a dead link must fail on a deadline, not hang the iPad.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchTimeoutError, fetchWithTimeout, withDeadline } from './fetch-timeout';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch that never answers, but honours abort the way a browser does. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
}

describe('fetchWithTimeout', () => {
  it('rejects with FetchTimeoutError once the deadline passes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const p = fetchWithTimeout('/api/x', {}, 5_000);
    const assertion = expect(p).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it('a timeout is not a TypeError — the queue must not read it as "offline"', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const p = fetchWithTimeout('/api/x', {}, 1_000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await p).not.toBeInstanceOf(TypeError);
  });

  it('passes a prompt response straight through and clears its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    const res = await fetchWithTimeout('/api/x', {}, 5_000);
    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a real network error stays itself — only a deadline becomes FetchTimeoutError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchWithTimeout('/api/x', {}, 5_000)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('withDeadline', () => {
  it('rejects a promise that never settles', async () => {
    vi.useFakeTimers();
    const p = withDeadline(new Promise<string>(() => {}), 2_000, 'signIn');
    const assertion = expect(p).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
  });

  it('resolves normally when the promise is prompt', async () => {
    await expect(withDeadline(Promise.resolve(7), 2_000, 'x')).resolves.toBe(7);
  });
});
