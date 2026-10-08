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

  it('passes a prompt response straight through and clears its timer once the body is read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    const res = await fetchWithTimeout('/api/x', {}, 5_000);
    expect(res.status).toBe(200);
    // ADR-0140 Am.1 — the deadline is still armed after the headers: the body
    // has not arrived yet.
    expect(vi.getTimerCount()).toBe(1);
    expect(await res.text()).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  // ADR-0140 Am.1 — FALSIFIED BY HAND: with the timer cleared at the headers
  // (the shipped version), `res.json()` here never settles and the test times out.
  it('a body that stalls after the headers still fails on the deadline', async () => {
    vi.useFakeTimers();
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stalledBody, { status: 200 })),
    );
    const res = await fetchWithTimeout('/api/x', {}, 5_000);
    const assertion = expect(res.json()).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it('a clone is guarded too, and a body read after the deadline rejects at once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 409 }),
      ),
    );
    const res = await fetchWithTimeout('/api/x', {}, 1_000);
    const clone = res.clone();
    const assertion = expect(clone.json()).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    await expect(res.text()).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  // ADR-0140 Am.1 — the shipped `{ ...init, signal }` silently discarded this.
  it("composes a caller's signal with the deadline instead of overwriting it", async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const caller = new AbortController();
    const p = fetchWithTimeout('/api/x', { signal: caller.signal }, 60_000).catch(
      (e: unknown) => e,
    );
    caller.abort();
    const err = await p;
    // The caller's abort is the caller's error — not dressed up as a timeout.
    expect(err).not.toBeInstanceOf(FetchTimeoutError);
    expect((err as Error).name).toBe('AbortError');
    expect(fetchSpy.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('an already-aborted caller signal aborts the request immediately', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const caller = new AbortController();
    caller.abort();
    // The abort fires before `fetch` subscribes, so honour `aborted` up front.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return new Response('ok');
      }),
    );
    const err = await fetchWithTimeout('/api/x', { signal: caller.signal }, 60_000).catch(
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('AbortError');
  });

  it('the deadline still fires when the caller supplied a signal of its own', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const caller = new AbortController();
    const p = fetchWithTimeout('/api/x', { signal: caller.signal }, 2_000);
    const assertion = expect(p).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    expect(caller.signal.aborted, 'the deadline must not abort the CALLER').toBe(false);
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
