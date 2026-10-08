// A `fetch` that cannot hang forever.
//
// Why this exists: browsers give a stalled request no deadline the app can rely
// on. On the Woodland floor the access point routinely reports "online" while the
// server is unreachable (see the 30s interval note in `drain-engine.ts`), and a
// request into that state can sit open for minutes. Every await behind it — the
// drain sweep, the PIN keypad's `busy` flag — then waits just as long, which an
// operator sees as a frozen iPad.
//
// Built on `AbortController` + `setTimeout` rather than `AbortSignal.timeout`:
// the iPads in the field are not all on a Safari that has the latter (16+).
//
// A timeout surfaces as `FetchTimeoutError`, an ordinary retryable failure. It is
// NOT a `TypeError`, so `isOfflineError` does not claim it, and callers that read
// a network-layer throw as "storage is blocked" (the R2 PUT) must check for it
// explicitly — a slow link is not a CORS refusal.

/** Deadline for the small JSON calls (mint, confirm, replay). */
export const API_TIMEOUT_MS = 20_000;
/** Deadline for a photo PUT to R2 — a large body on a weak link needs longer. */
export const UPLOAD_TIMEOUT_MS = 90_000;
/**
 * Deadline for a read-only status check that runs AFTER an action already spent
 * its API_TIMEOUT_MS inside the same watched job (ADR-0140 Am.1, review N3).
 * 20 s + 4 s stays under the 25 s stall watchdog; a 5 s read would tie it.
 */
export const STATUS_READ_TIMEOUT_MS = 4_000;

export class FetchTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`timeout after ${ms}ms: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

// ADR-0140 Amendment 1 — the deadline covers the WHOLE exchange, headers AND body.
//
// The first version cleared its timer when the headers arrived, so a response
// whose body then stalled (`await res.json()` on a link that delivered the status
// line and nothing more) had no deadline at all — the same "waits forever" the
// helper exists to remove, one await later. Now the timer stays armed until a body
// read SUCCEEDS (at which point every byte has arrived, for the clone too: a
// clone is a tee of the same stream), and each body reader on the returned
// response — `json`, `text`, `arrayBuffer`, `blob`, `formData`, and the same on a
// `clone()` — rejects with `FetchTimeoutError` if the deadline passes first.
//
// A response whose body is never read keeps its timer until the deadline, which
// then aborts the unread stream. That is harmless (nothing is waiting on it) and
// releases the connection.
//
// A caller-supplied `init.signal` is COMPOSED with the deadline, not overwritten:
// either one aborts the request. A caller abort surfaces as the caller's own
// AbortError; only the deadline produces `FetchTimeoutError`. Composed by hand
// because `AbortSignal.any` is newer than some floor iPads' Safari.

const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  ms: number = API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutWaiters = new Set<() => void>();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    for (const w of timeoutWaiters) w();
    timeoutWaiters.clear();
  }, ms);
  const done = (): void => clearTimeout(timer);

  const callerSignal = init.signal ?? null;
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const unhookCaller = (): void => callerSignal?.removeEventListener('abort', onCallerAbort);

  let res: Response;
  try {
    res = await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    done();
    unhookCaller();
    if (timedOut) throw new FetchTimeoutError(input, ms);
    throw e;
  }

  const guard = (r: Response): Response => {
    for (const name of BODY_READERS) {
      const original = (r[name] as () => Promise<unknown>).bind(r);
      Object.defineProperty(r, name, {
        configurable: true,
        value: () =>
          new Promise<unknown>((resolve, reject) => {
            if (timedOut) {
              reject(new FetchTimeoutError(input, ms));
              return;
            }
            const onTimeout = (): void => reject(new FetchTimeoutError(input, ms));
            timeoutWaiters.add(onTimeout);
            original().then(
              (v) => {
                timeoutWaiters.delete(onTimeout);
                done();
                unhookCaller();
                resolve(v);
              },
              (e: unknown) => {
                timeoutWaiters.delete(onTimeout);
                reject(timedOut ? new FetchTimeoutError(input, ms) : e);
              },
            );
          }),
      });
    }
    const originalClone = r.clone.bind(r);
    Object.defineProperty(r, 'clone', {
      configurable: true,
      value: () => guard(originalClone()),
    });
    return r;
  };
  return guard(res);
}

/** Race any promise against a deadline. Rejects with `FetchTimeoutError`. */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FetchTimeoutError(label, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
