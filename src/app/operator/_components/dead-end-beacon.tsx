'use client';

// ADR-0100 / ADR-0094 §P0 — mount this beside a state that offers no control.
//
// Renders NOTHING. Its whole job is to make an actionless render countable, so
// the discovery mechanism for this defect class stops being Bill's phone.
//
// ## Why it is a component and not a hook call inside each branch
//
// A `<DeadEndBeacon …/>` sits INSIDE the JSX branch it is measuring, so it mounts
// exactly when that branch renders and cannot drift away from it — the way a
// `useEffect` at the top of a component, gated on a condition restated by hand,
// silently would. It is the same reasoning `describeConsumedSlot` (ADR-0091) uses
// for decisions: put the thing next to the thing, so they cannot disagree.
//
// ## Deduped, because a render is not an event
//
// React re-renders freely, `<StrictMode>` double-mounts in dev, and a poll on a
// parent re-renders every child. Counting renders would measure React, not the
// floor. So each (surface, state, objectId) fires AT MOST ONCE per page lifetime,
// tracked in a module-scoped Set that dies with the page.
//
// The Set is deliberately module-scoped rather than per-component: an operator
// tapping between two cards in the same dead state should register two events
// (different objectIds) but re-rendering one card fifty times should register
// one. Keyed on the triple, that falls out for free.
//
// ## It cannot break the screen it measures
//
// `keepalive` so the report survives the navigation that usually follows a dead
// end, and every failure is swallowed. An instrument that can fail the render it
// is measuring is a strictly worse defect than the one being measured.
//
// ## It reads NO context, deliberately
//
// An earlier cut called `useLocale()` here. Two things were wrong with that. The
// small one: it made every existing test that renders an instrumented component
// fail unless it added `useLocale` to its `@/i18n/provider` mock — telemetry
// should not be able to break a suite that is not about telemetry. The real one:
// the route resolves the locale from `getLocale()`, which is SESSION-FIRST
// (ADR-0061 D-4), so the server's answer is the operator's actual stored
// preference while the client's is whatever this render happened to paint. The
// server already knows, and it knows better.

import { useEffect } from 'react';
import type { DeadEndSurface, DeadEndState } from '@/lib/observability/dead-end';

const reported = new Set<string>();

/** Exported for tests only — a shared Set across cases would make them order-dependent. */
export function __resetDeadEndBeacon(): void {
  reported.clear();
}

export function DeadEndBeacon({
  siteCode,
  surface,
  state,
  objectId = null,
}: {
  siteCode: string;
  surface: DeadEndSurface;
  state: DeadEndState;
  objectId?: string | null;
}) {
  useEffect(() => {
    const key = `${surface}:${state}:${objectId ?? '-'}`;
    if (reported.has(key)) return;
    reported.add(key);

    void fetch(`/api/operator/${siteCode}/dead-end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Survives the unload when the operator gives up and navigates away —
      // which is precisely the event most worth having.
      keepalive: true,
      body: JSON.stringify({ surface, state, objectId }),
    }).catch(() => {
      // Offline is the common case on this floor and is not worth a retry: the
      // offline queue is for the operator's WORK, and telemetry has no business
      // competing with it for the one durable store on the iPad (hard rule #9).
      // A dead end an operator hit while offline is a lost datum, not a lost
      // count of mattresses.
    });
  }, [siteCode, surface, state, objectId]);

  return null;
}
