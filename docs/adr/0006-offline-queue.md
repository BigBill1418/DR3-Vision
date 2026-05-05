# ADR-0006: Offline queue strategy

**Date:** 2026-05-04
**Status:** Accepted

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
