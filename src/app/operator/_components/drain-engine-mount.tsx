'use client';

import { useEffect } from 'react';
import { registerBackgroundSync, startDrainEngine } from '@/lib/drain-engine';

// ADR-0078 G8 — the drain engine's one mount point.
//
// Bill: *"drain should happen no matter what page its on and it should make sure
// all data is always pushed down - not as an afterthought."*
//
// So the engine is mounted HERE, inside `FloorShell`, which the operator
// route-group layout wraps around all nine screens — the same place the chrome
// and the locale switcher already live for the same reason. Every operator
// screen inherits it because it is ABOVE all of them rather than inside any of
// them, and no page has to remember anything.
//
// This component renders nothing. It exists because `startDrainEngine` is
// deliberately framework-free (plain DOM, unit-testable without React) and
// something has to own its lifetime.
export function DrainEngineMount() {
  useEffect(() => {
    const stop = startDrainEngine();
    // Progressive enhancement, capability-detected. Resolves `false` on iOS —
    // WebKit has never shipped Background Sync — which is a supported outcome,
    // not a failure. The honest consequence is stated in ADR-0078: on an iPad
    // the queue drains whenever the app is OPEN on any screen (which the engine
    // guarantees) and resumes the instant it is foregrounded; there is no
    // closed-app execution and we do not claim any.
    void registerBackgroundSync();
    return stop;
  }, []);
  return null;
}
