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

## Amendment 1 — the floor screens' own requests, and the body read (2026-10-07)

**Status:** Proposed 2026-10-07 (PR `fix/adr0140-remaining-deadlines`, not merged). Staff-facing behaviour on the
dock iPads: ships only on Bill's go.

### Context

An independent review of PR #294 (Ryan, 2026-10-07) found three gaps in what the Decision above claims:

1. The deadline reached the offline-queue drain and the keypad, but **not the floor screens' own live requests**.
   Eleven bare `await fetch(` calls remained in count, void, drop-off, inbound and load photo; two more turned up
   in processed and queue conflicts while closing it. Each could hold its screen's `busy` flag forever, and none of
   those screens uses `useTransition`, so the stall watchdog never saw them.
2. `fetchWithTimeout` cleared its timer **when the headers arrived**. A body that stalled after the status line
   (`await res.json()`) had no deadline.
3. `{ ...init, signal }` **overwrote** a caller's `signal`, so a caller abort was silently ignored.

### Decision

- **One deadline for the whole exchange.** The timer stays armed until a body read succeeds. Every body reader on
  the returned `Response` (`json`, `text`, `arrayBuffer`, `blob`, `formData`, and the same on `clone()`) rejects
  with `FetchTimeoutError` if the deadline passes first. Once any read succeeds, every byte has arrived, clone
  included (a clone is a tee of the same stream), so the timer is cleared. If the body is never read, the timer
  fires at the deadline and aborts the unread stream. Nothing waits on that stream, so the abort is harmless.
  We chose this over buffering the body inside the helper because rebuilding a `Response` loses `type`
  (`opaqueredirect` is what `isAuthResponse` keys on under `redirect: 'manual'`), `url` and `redirected`, and
  throws for status 0 and the null-body statuses.
- **A caller's signal is composed, not replaced.** Either signal aborts the request. A caller abort keeps the
  caller's own `AbortError`; only the deadline yields `FetchTimeoutError`. The two are composed by hand, because
  `AbortSignal.any` is newer than some floor iPads' Safari.
- **Every awaited request on an operator screen goes through `fetchWithTimeout`.** That is 13 call sites: 20 s for
  JSON and 90 s (`UPLOAD_TIMEOUT_MS`) for the two live R2 PUTs.

  | Screen                                 | Requests                                           | On timeout                                                                                                                                                                                 |
  | -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `count/count-client.tsx`               | count POST; hold approve POST; hold discard DELETE | count is **queued** under the key minted at the tap. Approve and discard show "Couldn't save" (no key, not queued); a retry of one that landed meets the existing hold-gone path (404/409) |
  | `count/void-client.tsx`                | void POST                                          | "Couldn't save", back to the list. A void is never queued, by design                                                                                                                       |
  | `dropoff/dropoff-client.tsx`           | mint; R2 PUT (90 s); submit                        | **queued** with the blob, under the tap key. A PUT timeout queues with the minted key and is never `blocked:`                                                                              |
  | `inbound/inbound-client.tsx`           | inbound POST                                       | **queued** under the tap key                                                                                                                                                               |
  | `processed/processed-client.tsx`       | processed POST                                     | **queued** under the tap key                                                                                                                                                               |
  | `load/[id]/photo-input.tsx`            | mint; R2 PUT (90 s); confirm                       | **queued**, and the stage advances, exactly as when offline                                                                                                                                |
  | `queue/conflicts/conflicts-client.tsx` | discard POST                                       | "Discard failed". The local row is kept, because it is removed only on an acknowledged audit write                                                                                         |

  A request that times out may still have landed. That is the case the ADR-0078 idempotency key exists for, so
  every keyed write queues the same way an offline one does (`isOfflineError(e) || e instanceof
FetchTimeoutError`), and its replay returns the original row. `FetchTimeoutError` is still not a `TypeError`.
  The drain's exception to the blocked-upload rule is unchanged, and it is now tested for drop-offs as well as
  load photos.

- **Stall watchdog for `useState`-busy screens.** `useStallWatch()`, in the same module as `useWatchedTransition`
  and sharing its counter, wraps the handlers on count, void, inbound, processed and queue conflicts. The 20 s
  deadline already bounds the request itself, so the banner covers what a deadline cannot reach: an IndexedDB
  enqueue that never resolves, or a refresh that never lands. The photo flows (drop-off, load photo) are
  **deliberately not watched**. A legitimate PUT can take up to 90 s, and offering Reload mid-upload would discard a
  photo that exists only in memory until it is queued. Their worst case is bounded by the deadlines instead: about
  130 s (20 + 90 + 20), then queued.
- **Left bare on purpose:** the three `void fetch(` dead-end telemetry beacons (`dead-end-beacon.tsx`,
  `write-refusal.tsx`, `stage-liveness.tsx`). They are fire-and-forget, nothing awaits them, and they hold no busy
  state. `floor-fetch-deadline.test.ts` fails the build on any other bare `fetch(` under `src/app/operator`.

### Not verified

No real iPad has been stalled against this code; every test uses a fetch double that honours abort. The claim
that body readers reject on abort in iOS Safari comes from the Fetch spec. The guard does not depend on it,
because each reader is also raced against the timer.

### Tests

`fetch-timeout.test.ts`: body stall after headers, clone, caller-signal composition (3 cases), timer cleared only
after a read. `stall-banner.test.tsx` › `useStallWatch`. Deadline cases on each screen:
`count-client.refusal.test.tsx`, `inbound-client.refusal.test.tsx`, `processed-client.refusal.test.tsx`,
`dropoff-client.refusal.test.tsx` (mint, PUT and submit), `photo-input.deadline.test.tsx` (mint, PUT and confirm),
`void-client.deadline.test.tsx`. Drain side: `offline-queue.dropoff.test.ts` › a drop-off PUT timeout stays
retryable and is never blocked, plus the guard-the-guard that a `TypeError` after a good mint still is blocked.
Static: `floor-fetch-deadline.test.ts`. Each new behavioural test was falsified by running it against the shipped
code from `origin/main`, where it failed.
