// Audit 2026-07-16 RES — the shared single-slot Chromium render gate.
// Proves the two properties the three PDF renderers rely on: renders serialize
// (concurrency 1, FIFO, permit freed even on throw), and a render that waits
// longer than the max-wait fails with a typed 503 rather than hanging forever.

import { describe, it, expect, vi } from 'vitest';
import { Semaphore, ChromiumBusyError, chromiumSemaphore, withChromium } from './chromium-semaphore';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Let queued microtasks settle so "started vs queued" is observable.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Semaphore — serialization', () => {
  it('runs one at a time; a second caller waits for the first to release', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const first = deferred();

    const p1 = sem.run(async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const p2 = sem.run(async () => {
      order.push('b-start');
    });

    await flush();
    expect(order).toEqual(['a-start']); // b has NOT started — it is queued
    expect(sem.pending).toBe(1);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    expect(sem.pending).toBe(0);
  });

  it('dispatches queued waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const hold = deferred();

    const p0 = sem.run(async () => {
      await hold.promise;
    });
    const rest = [1, 2, 3].map((n) => sem.run(async () => void order.push(n)));

    await flush();
    expect(order).toEqual([]); // all three queued behind p0
    hold.resolve();
    await Promise.all([p0, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the permit even when the wrapped work throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // Slot must be free — the next run acquires immediately.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    expect(sem.pending).toBe(0);
  });

  it('rejects a non-positive permit count', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});

describe('Semaphore — max-wait timeout', () => {
  it('rejects a waiter with ChromiumBusyError once maxWaitMs elapses', async () => {
    vi.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      const hold = deferred();
      const p1 = sem.run(async () => {
        await hold.promise;
      });
      const p2 = sem.run(async () => 'never', 1000);
      const rejects = expect(p2).rejects.toBeInstanceOf(ChromiumBusyError);

      await vi.advanceTimersByTimeAsync(1000);
      await rejects;
      expect(sem.pending).toBe(0); // timed-out waiter removed from the queue

      hold.resolve();
      await p1; // holder still finishes cleanly
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timeout for a waiter that acquires in time', async () => {
    vi.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      const hold = deferred();
      const p1 = sem.run(async () => {
        await hold.promise;
      });
      const p2 = sem.run(async () => 'ok', 10_000);

      await vi.advanceTimersByTimeAsync(500);
      hold.resolve();
      await expect(p2).resolves.toBe('ok');
      await p1;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ChromiumBusyError is a typed 503 carrying the waited duration', () => {
    const err = new ChromiumBusyError(1234);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.waitedMs).toBe(1234);
    expect(err.name).toBe('ChromiumBusyError');
  });
});

describe('withChromium — shared process-wide gate', () => {
  it('serializes overlapping renders through the shared chromiumSemaphore', async () => {
    expect(chromiumSemaphore.pending).toBe(0);
    const hold = deferred();
    const p1 = withChromium(async () => {
      await hold.promise;
      return 1;
    });
    const p2 = withChromium(async () => 2);

    await flush();
    expect(chromiumSemaphore.pending).toBe(1);

    hold.resolve();
    await expect(Promise.all([p1, p2])).resolves.toEqual([1, 2]);
    expect(chromiumSemaphore.pending).toBe(0);
  });

  it('honors the CHROMIUM_RENDER_MAX_WAIT_MS env override', async () => {
    vi.useFakeTimers();
    const prev = process.env['CHROMIUM_RENDER_MAX_WAIT_MS'];
    process.env['CHROMIUM_RENDER_MAX_WAIT_MS'] = '50';
    try {
      const hold = deferred();
      const p1 = withChromium(async () => {
        await hold.promise;
      });
      const p2 = withChromium(async () => 'x');
      const rejects = expect(p2).rejects.toBeInstanceOf(ChromiumBusyError);

      await vi.advanceTimersByTimeAsync(50);
      await rejects;

      hold.resolve();
      await p1;
    } finally {
      if (prev === undefined) delete process.env['CHROMIUM_RENDER_MAX_WAIT_MS'];
      else process.env['CHROMIUM_RENDER_MAX_WAIT_MS'] = prev;
      vi.useRealTimers();
    }
  });
});
