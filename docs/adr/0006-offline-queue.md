# ADR-0006: Offline queue strategy

**Date:** 2026-05-04
**Status:** Accepted — Amendment 1 (2026-11-11): the service worker never replays a server action

## Context

DR3-Vision is a critical-path system: trucks unload at the dock; the iPad captures the data; the data feeds billing, compliance, and audit. If the iPad cannot reach the server, work cannot stop.

Network outage scenarios:
- Site WiFi flaky (rare per Q21 — both sites have good WiFi)
- iPad cellular fallback failed (rare — two-path redundancy)
- CHAD-HQ unreachable (network or host issue)
- Application server crashed mid-deploy
- Database temporarily unavailable

Bill explicitly rejected paper fallback (Q20). The offline queue is the *only* fallback.

## Decision

Use **IndexedDB + Workbox Background Sync** for an aggressive offline queue.

### What queues
All operator submissions, including:
- BOL photo upload
- Weight ticket photo + value
- Door-open photo + timer-start timestamp
- Stack count submissions
- Concern records (multi-photo + annotation + voice note)
- Rejection records
- Final submit (timer-stop timestamp)

### How it queues
- Service Worker registered with explicit cache versioning
- Workbox Background Sync intercepts failed POST/PATCH requests and queues them in IndexedDB
- Photos stored as Blobs in IndexedDB until upload confirms
- Queue replays when network returns; replay order preserved (a load's submissions sync in the order they were made)

### How it surfaces
- A small queue-health indicator on the operator screen shows pending submissions
- On next login, unresolved queue items surface as "Sync these now" prompts
- Manager portal sees a per-iPad queue depth metric on the live dock view

### Conflict resolution
- iPad-side state is authoritative for the operator's actions (counts, photos, concerns)
- If a manager has reassigned a load between the offline period and the sync, the iPad's submission for that load creates a flagged conflict surfaced on the manager portal
- Audit log captures both versions

### Cache durability
- PWA shell, all routes, all critical assets, and the active operator's queue must survive iPad reboots, iOS updates, and Safari tab reloads
- Service Worker uses explicit versioning; assets served with appropriate `Cache-Control` headers
- Monthly cache-recovery drills documented in deployment runbook

### Hard failure
The only scenario where the offline queue fails is **PWA cache unrecoverable AND both WiFi and cellular unreachable**. This is documented as an operational risk; mitigation is (a) cache durability engineering and (b) two-path network. There is no paper recovery path.

## Alternatives considered

- **Paper fallback when offline** — rejected by Bill in Q20. Adds operational complexity, paper-data sync risk, and dual-system maintenance.
- **Photos-only emergency capture** — operators take photos with the native iPad Camera app, upload later. Half-measure; if the queue works, this is unnecessary.
- **Service Worker without IndexedDB** — Workbox Background Sync alone doesn't persist arbitrary structured data, only fetch requests. We need both.
- **Synchronous online-only mode** — would force operators to wait for network. Rejected as a non-starter.

## Consequences

- The offline queue is a Day 1 quality gate. Sprint 1 cannot ship without it being rock-solid.
- IndexedDB has size limits (~50% of free disk on iOS Safari). At ~5 photos × 5MB × 100 queued submissions = 2.5GB worst case, well within limits.
- Photos are uploaded when the queue replays; the user's submission is "complete" from their perspective even before the photo finishes uploading. This is acceptable because the iPad's queue is the source of truth.
- A failed-replay scenario (auth expired, server rejected) surfaces as an unresolved-queue alert; never silently dropped.

## References

- Charter §5.5 (Offline strategy), §5.8 (Outage strategy)
- Q20 in charter v0.28 changelog (no paper fallback)
- Q21 in charter v0.29 changelog (WiFi + cellular both confirmed)

## Amendment 1 — the service worker never replays a server action (2026-11-11)

**Decided by Bill, 2026-11-11** (approved the change by popup). OPEN-ITEMS 0.HF HF-5.

### Decision

Next.js server actions (same-origin `POST` with a `Next-Action` header) are **never** queued or replayed by the
service worker. `src/app/sw.ts` routes them to `NetworkOnly` with no plugins, so a failure reaches the page as an
ordinary rejected `fetch`. **The IndexedDB queue in `src/lib/offline-queue.ts` is the only replay path for server
actions.** That queue carries an idempotency key per write, replays through `/api/queue/replay` under the session
that is signed in at sweep time (identity is re-derived server-side, never taken from the queued body), parks a
401 as AUTH_EXPIRED instead of dropping it, and has the ADR-0140 deadlines and watchdog.

On activation the new worker deletes every row Serwist holds for the retired `dr3-server-actions` queue
(`serwist-background-sync` database, `requests` store, `queueName` index) **without sending any of them**
(`src/lib/sw-legacy-queue.ts`). They were written before the deploy, so they carry an action id and a session that
may no longer be valid.

### Evidence (why the earlier behaviour was wrong)

- The route was added in `9f1ebd8` (2026-05-06, T-009) with a 24 h `BackgroundSyncPlugin` queue and was never
  recorded in an ADR. The "How it queues" section above says Workbox Background Sync queues POST/PATCH, but it
  was written before the app grew its own queue for server actions (ADR-0078), and it never considered a replay
  carrying a different operator's session.
- **Wrong operator.** A SW replay re-sends the stored request and the browser attaches whatever cookie is live at
  replay time. If a different operator has signed in on the iPad by then, the write lands under their identity.
- **No idempotency for most actions.** Only `addStackAction` and `finishUnloadAction` carry a key. A SW replay of
  any other action, on top of the app queue's own replay, writes twice.
- **Stale action ids after a deploy.** Action ids change per build, so a replay queued before a deploy fails with
  `Failed to find Server Action`.
- **Safari replays on worker start.** iPad Safari has no Background Sync API. Serwist then replays the queue
  directly from the `BackgroundSyncQueue` constructor (`node_modules/serwist/dist/chunks/printInstallDetails-*.js`,
  `_addSyncListener`, the non-sync branch), so on the floor iPads the queue replayed every time the worker started,
  not on a sync event. That is also why the purge uses raw IndexedDB: constructing a queue to empty it would
  replay it first.

### What did not change

The photo queues (`dr3-photo-mint`, `dr3-photo-put`, `dr3-photo-confirm`), the never-cache `/healthz` rule
(ADR-0078), the R2 and operator-GET caches, `defaultCache`, and the ADR-0027 update flow (`skipWaiting: false`,
`SKIP_WAITING` message, UpdatePrompt) are unchanged. `CACHE_VERSION` stays `dr3-v1`: the worker script's bytes
change, which is what makes the browser install the new worker, and bumping `cacheId` would throw away the
precached shell and photo cache for no gain. It has never been bumped since `9f1ebd8`.

### What the page sees now

Before and after, a failed server action rejected to the page (NetworkFirst with nothing cached also throws). The
difference is that the worker no longer also keeps a silent copy to send later. The floor clients that enqueue on
`isOfflineError` (`stage-stacks.tsx` add-stack and finish, count, processed, inbound) keep doing so. Callers with
no `catch` (`stage-bol.tsx`, `stage-door.tsx`, `stage-decision.tsx`) let the rejection reach
`src/app/operator/error.tsx`, which shows the floor error screen with a retry. How each failure is worded is
ADR-0144's lane (PR-1) and the later caller-messaging work, not this amendment.

### Residuals

- The worker uses `skipWaiting: false` (ADR-0027), so the new worker waits until UpdatePrompt promotes it (the
  operator taps Reload) or every tab using the app is closed. Until then the OLD worker stays in control and keeps
  replaying its `dr3-server-actions` queue each time it restarts. The purge runs only when the new worker
  activates.
- The photo queues still replay from the worker under the live cookie. Same class of problem, left alone on purpose
  in this amendment (OPEN-ITEMS 0.HF HF-6).
- If the purge fails (it is logged), the rows stay but are inert: nothing constructs that queue any more.
- Not yet proved on a real iPad (OPEN-ITEMS 0.HF HF-5).

### Tests

- `src/app/sw.server-actions.test.ts`: real `sw.ts` and production `defaultCache`. The server-action route resolves
  to `NetworkOnly` with no plugins, no `dr3-server-actions` queue is built, a failed fetch rejects once and is not
  retried, and `activate` empties that queue but keeps the photo rows. 3 of 5 failed on `origin/main` (40a5fa9)
  before the change.
- `src/lib/sw-legacy-queue.test.ts`: deletes only the named queue, sends nothing, idempotent, does not create the
  database on a device that never had one.
- `src/lib/offline-queue.reauth.test.ts`: `add_stack` / `finish_unload` queued under AUTH_EXPIRED. The same operator
  signs in → one replay with the original key, then nothing. A different operator → 403, the row is kept as
  `conflict:load_taken_over` and never sent again.
- `src/lib/floor-exactly-once.db.test.ts` (real Postgres): a replay under a different operator is refused 403 and
  writes no stack and no finish. The existing cases there already prove a second replay of the same key writes
  nothing.
