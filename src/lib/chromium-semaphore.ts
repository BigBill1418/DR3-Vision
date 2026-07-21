// Shared in-process concurrency gate for headless-Chromium PDF renders
// (audit 2026-07-16 RES). Every `chromium.launch` site in the app — payroll
// (`bonus/pdf.ts`), COR (`cor/pdf.ts`), and AP stamping (`ap/stamp.ts`) —
// funnels through the single-slot gate exported here, so overlapping renders
// serialize instead of each spawning a Chromium that contends for the serving
// container's ~1465MiB budget and OOM-kills the app.
//
// Scope: single Node process only (module singleton). It does NOT coordinate
// across containers/replicas — the cron containers are separate processes with
// their own memory limits (docker-compose `mem_limit`); this gate protects the
// serving app from spawning N concurrent browsers within its own process.

/** Default cap on how long a render waits in the queue before it gives up. */
const DEFAULT_MAX_WAIT_MS = 60_000;

/**
 * Thrown when a render cannot acquire the Chromium slot within the max wait.
 * Surfaced as 503 (transient — a retry once the in-flight render finishes will
 * succeed) rather than hanging the request/worker for an unbounded time.
 */
export class ChromiumBusyError extends Error {
  readonly status = 503 as const;
  constructor(readonly waitedMs: number) {
    super(
      `Chromium render slot busy: gave up after ${waitedMs}ms waiting for an ` +
        `in-flight PDF render to finish (render concurrency is capped at 1 to ` +
        `protect the serving container's memory budget). Retry shortly.`,
    );
    this.name = 'ChromiumBusyError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal counting semaphore with FIFO queueing and a per-acquire max-wait
 * timeout. A permit is transferred directly to the next waiter on release, so
 * throughput never stalls; a waiter that times out is removed from the queue
 * and rejected with {@link ChromiumBusyError}. The permit is always released,
 * even when the wrapped work throws.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Waiter[] = [];

  constructor(private readonly permits: number = 1) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`);
    }
    this.available = permits;
  }

  /** Callers currently waiting for a permit (queue depth) — for tests/metrics. */
  get pending(): number {
    return this.queue.length;
  }

  private acquire(maxWaitMs: number): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new ChromiumBusyError(Date.now() - startedAt));
      }, maxWaitMs);
      this.queue.push({ resolve, reject, timer });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.available += 1;
  }

  /**
   * Run `work` while holding a permit. Waits up to `maxWaitMs` for a slot; on
   * timeout the promise rejects with {@link ChromiumBusyError} and `work` never
   * runs. The permit is always released, even if `work` throws.
   */
  async run<T>(work: () => Promise<T>, maxWaitMs: number = DEFAULT_MAX_WAIT_MS): Promise<T> {
    await this.acquire(maxWaitMs);
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}

/** Process-wide single-slot gate shared by ALL headless-Chromium renderers. */
export const chromiumSemaphore = new Semaphore(1);

/** Max queue wait, overridable via env; falls back to {@link DEFAULT_MAX_WAIT_MS}. */
function maxWaitMs(): number {
  const raw = Number(process.env['CHROMIUM_RENDER_MAX_WAIT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_WAIT_MS;
}

/**
 * Run a headless-Chromium render (launch → produce → close) under the shared
 * single-slot gate. Wrap the full launch/close span so a queued render never
 * launches a second browser while another is live.
 */
export function withChromium<T>(render: () => Promise<T>): Promise<T> {
  return chromiumSemaphore.run(render, maxWaitMs());
}
