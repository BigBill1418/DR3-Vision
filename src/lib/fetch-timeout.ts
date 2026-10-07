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

export class FetchTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`timeout after ${ms}ms: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  ms: number = API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) throw new FetchTimeoutError(input, ms);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
