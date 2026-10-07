# ADR-0140 — An unanswered request is a failure, not a state

**Status:** Accepted 2026-10-06 (Bill: _"ship the iPad timeout fixes now"_, after the 2026-10-06 Woodland report
_"login screen stuck - load buttons stuck ipad browser appears frozen"_).

## Context

On 2026-10-06 (~9:25 AM PDT) the Woodland iPads froze: the PIN keypad stopped responding, the load buttons stayed
disabled, the browser looked hung. The investigation found **no server fault** — `/healthz` 200, DB healthy, no stuck
transactions or locks, no 5xx in 26 h, nothing deployed for a week, PIN logins succeeding at 9:27/9:31 AM, and a
fresh browser loading the login and name picker in under a second. So the freeze lives in the client, and the
**root cause was not reproduced** — the iPad that froze was not inspected.

What the code review did find, in the exact paths the symptoms name, is that **nothing on the iPad ever gave up on a
request**:

1. `keypad.tsx` set `busy` on the 4th digit and cleared it only if `signIn` rejected or returned an error. A
   `signIn` that never answered (the floor's access point routinely reports "online" while the server is
   unreachable — `drain-engine.ts`), or a post-sign-in navigation that never landed, left every key disabled forever.
2. All seven `fetch` calls in the offline-queue replay path (`offline-queue.ts`) had no deadline. One stalled call
   held `replayInFlight` open, so every later sweep waited on it.
3. Every floor button runs a server action in `useTransition`. A client cannot time a server action out, and Next runs
   them one at a time, so one stalled action left its button disabled — and queued everything behind it.

## Decision

- **`fetchWithTimeout` / `withDeadline`** (`src/lib/fetch-timeout.ts`). Queue JSON calls get 20 s, photo PUTs to R2 90 s.
  Built on `AbortController` + `setTimeout`, not `AbortSignal.timeout` (not on every iPad's Safari). A timeout throws
  `FetchTimeoutError` — deliberately **not** a `TypeError`, so `isOfflineError` does not claim it, and the R2 PUT
  catch treats it as an ordinary retryable failure instead of `blocked:` (a slow link is not a CORS refusal).
- **Keypad:** `signIn` is raced against 20 s; a successful sign-in whose navigation has not unmounted the screen within
  10 s hands the keys back (the session exists, so no PIN is lost). The stall timer is cleared on unmount.
- **Stall watchdog** (`useWatchedTransition` + `StallBanner` in `FloorShell`). A drop-in for `useTransition` on every
  operator screen: if work handed to `startTransition` has not settled in 25 s it shows a banner with **Reload**.
  It tracks its own in-flight work rather than reading `isPending`, because the app router's bundled React spans an
  async action while the React 18 the unit tests resolve does not — reading our own settle point makes the tests prove
  what runs on the iPad. It does not cancel the action (the write may land; queued writes are idempotent, and a reload
  is the only thing that frees a wedged action queue). Strings are in en/es/ur.
- **`global-error.tsx`** gets a Reload button: installed to the home screen there is no browser refresh control.

## Not decided here / known limits

- **The trigger of the 2026-10-06 freeze is unproven.** These changes remove the "waits forever" failure mode from
  every path the symptoms implicate; if it recurs, capture the iPad's state first (service-worker version, queue rows
  and their `last_error`, whether the banner appeared) before theorising again.
- A timed-out replay may have landed on the server. That is already handled: every replay carries the idempotency key
  minted at the operator's tap, and a replay of a landed write returns the original. A timed-out photo mint leaves an
  orphaned R2 object (the accepted trade documented in ADR-0086/0085).
- A stalled server action still occupies Next's action queue until reload; the banner is the escape, not a cure.

## Tests

`fetch-timeout.test.ts`; `offline-queue.test.ts` › "replay network deadlines" (hung replay is abandoned, kept,
retryable — falsified by restoring the bare `fetch`); `[userId]/keypad.test.tsx` (never-answering `signIn`, stalled
navigation, no stall reset after a working navigation); `_components/stall-banner.test.tsx`.
