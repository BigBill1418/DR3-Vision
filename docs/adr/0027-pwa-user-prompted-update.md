# ADR-0027: PWA user-prompted update (waiting-SW + tap-to-reload)

**Date:** 2026-06-15
**Status:** Accepted
**Supersedes (in part):** the "prompt UI left as a follow-up" note in `src/app/sw.ts` (T-009 / ADR-0006)

## Context

DR3-Vision is an installed Serwist PWA (ADR-0006). The service worker
precaches the Next.js app shell, including the hashed
`/_next/static/chunks/*.js` bundles. After a deploy those hashes change.

An **installed PWA that is left open** never reloads on its own. With the
previous SW config (`skipWaiting: true` + `clientsClaim: true`) the new SW
_would_ self-activate — but only after a navigation, full reload, or
close-and-reopen. An always-open installed PWA on the dock iPad does none of
those on its own, so it kept serving the **old precached shell**. The old
shell then requested chunk URLs that the new deploy no longer serves → 404 →
blank pages.

This actually happened: a deploy left the open PWA on a stale shell, pages
rendered blank, and it read to the operator as "all my data is gone." Nothing
was lost — the shell was simply stale — but a blank screen is indistinguishable
from data loss to the person at the dock.

We want an **explicit, user-controlled** update path so a stale shell can
never silently strand anyone, and so we never auto-reload an operator who is
mid data-entry on a load.

## Decision

Adopt the standard **"waiting service worker" update pattern**:

1. **`skipWaiting: false`** in `src/app/sw.ts`. A freshly installed SW now
   parks in the `waiting` state instead of self-activating. `clientsClaim`
   stays `true` so that, once the new SW _does_ activate, it controls the open
   page immediately (no second navigation). The existing `SKIP_WAITING`
   message handler is retained — it is now the mechanism the client uses to
   promote the waiting worker on demand.

2. A client component **`src/app/UpdatePrompt.tsx`** that:
   - reads `navigator.serviceWorker.getRegistration()`, checks
     `registration.waiting` on mount (a worker may already be parked from a
     deploy that happened while the tab was closed), and listens for
     `updatefound` + the installing worker's `statechange`;
   - surfaces a **non-intrusive bottom banner** only when a worker reaches
     `installed` **and** `navigator.serviceWorker.controller` exists — i.e. a
     genuine _update_, never the first-ever install;
   - on **Reload** tap: posts `{ type: 'SKIP_WAITING' }` to the waiting worker,
     then reloads **exactly once** on `controllerchange` (guarded by a
     `refreshing` flag to prevent reload loops);
   - **never auto-reloads** (operators may be mid data-entry);
   - is SSR-safe (`typeof navigator`, `'serviceWorker' in navigator`) and
     no-ops gracefully where service workers are unsupported;
   - offers a **Dismiss** so a busy operator can defer.

3. Mounted in the **root app shell** (`src/app/layout.tsx`) so it appears on
   every surface — operator iPad, manager dashboard, bonus. The root layout has
   no `I18nProvider` of its own (each route-group layout mounts one), so the
   prompt is wrapped in a **scoped** `I18nProvider` with the operator
   dictionary, which carries the new `update_prompt.*` keys. This is the
   smallest correct i18n integration and does not collide with the child
   providers.

4. Strings (`update_prompt.title/body/reload/dismiss`) ship in **en/es/ur**
   (CLAUDE.md hard rule #4). The banner uses brand green/cyan on the dark
   space surface (rule #3) and `onClick` handlers, not `<form>` (rule #10).

## Why not keep `skipWaiting: true` + auto-claim?

That is exactly the config that produced the incident: the SW _can_
self-update, but only on a navigation the always-open PWA never performs, and
when it does it would reload the operator without warning. A user-controlled
prompt is both more reliable (it detects the waiting worker proactively) and
safer (the operator chooses the moment to reload).

## Consequences

- A new deploy now surfaces a visible "A new version is available — Reload"
  banner on open PWAs instead of silently going stale.
- The **offline-queue / BackgroundSyncPlugin** runtime caching in `sw.ts` is
  untouched — only the `skipWaiting` flag changed.
- `/sw.js` is already served `no-store`/`must-revalidate` (next.config.js), so
  the browser still picks up the new SW on the next page load; the banner is
  the surfacing layer on top of that.
- First-ever installs do not prompt (no controller yet), avoiding a spurious
  "update available" on first launch.

## References

- ADR-0006 — Offline queue strategy (the SW this builds on).
- `src/app/sw.ts`, `src/app/UpdatePrompt.tsx`, `src/app/layout.tsx`.
- `src/app/UpdatePrompt.test.tsx` — unit coverage for the banner + SW logic.
