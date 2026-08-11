// @vitest-environment jsdom
//
// ADR-0074 Amendment 1 — the terminal screen is a ROUTE, not a promise.
//
// ## The defect this pins (production, 2026-08-10)
//
// The `submitted` / `rejected` branch of `LoadWorkflow` rendered exactly one
// paragraph:
//
//     <p>{t('workflow.load_done_returning', { status })}</p>
//         // en: "Load {{status}}. Returning to the name picker…"
//
// No button, no link, no redirect, no timer — nothing that returns anywhere.
// The copy promised a navigation the component never performed, in three
// locales.
//
// It was justified in a comment as "defensive — submit/reject server actions
// sign the operator out and redirect, so reaching here is rare." That premise
// was false in the one way that mattered: it is reachable WITHOUT submitting
// anything. Tapping a check-in card whose `expected_loads` slot has already been
// consumed routes — correctly, via the idempotent `startInboundLoad` — straight
// to the existing child load, and if that child is terminal you land here. On
// 2026-08-10 the Santa Rita truck's operator landed here on every tap, and the
// screen's only offer was a sentence claiming it was taking them somewhere.
//
// A dead end with reassuring copy is worse than a dead end, because it tells the
// operator to wait rather than to act. Same class as the ADR-0065 Amendment 1
// "Something went wrong" page and the ADR-0082 silent redirect loop: the fix is
// always a named destination the thumb can reach.
//
// These tests assert the rendered ANCHOR and its href, not a branch flag — a
// component that merely *decided* to navigate is what shipped.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LoadStatus } from '@prisma/client';

// The stage components are never rendered on a terminal status, but they are
// imported, and they reach for server actions / `next/navigation` at module
// load. Stub the whole set so this suite exercises only the dispatch branch.
vi.mock('./stage-bol', () => ({ StageBol: () => null }));
vi.mock('./stage-weight', () => ({ StageWeight: () => null }));
vi.mock('./stage-door', () => ({ StageDoor: () => null }));
vi.mock('./stage-decision', () => ({ StageDecision: () => null }));
vi.mock('./stage-stacks', () => ({ StageStacks: () => null }));
vi.mock('./stage-reject', () => ({ StageReject: () => null }));
vi.mock('./stage-finish', () => ({ StageFinish: () => null }));
// ADR-0090 C — same reason as the stages above: the void panel reaches for
// `../../actions` at module load, which pulls in next-auth and fails to resolve
// under the test runner. This suite exercises the dispatch branch only.
vi.mock('./void-load-panel', () => ({
  VoidLoadPanel: () => React.createElement('div', { 'data-testid': 'void-panel' }),
}));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useI18n: () => ({
      t: (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
      locale: 'en',
    }),
  };
});

import { LoadWorkflow } from './load-workflow';

const SITE = 'woodland';

function renderAt(status: LoadStatus) {
  return render(
    <LoadWorkflow
      siteCode={SITE}
      load={{ id: 'load-1', status, unload_started_at: null, total_units: 159, stacks: [] }}
      operatorName="Marisol"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ADR-0074 Am.1 — a terminal load offers a way back to the queue', () => {
  it('THE DEAD END: a `submitted` load renders a link to the queue, not a promise', () => {
    renderAt('submitted');

    const back = screen.getByRole('link');
    expect(back.getAttribute('href')).toBe(`/operator/${SITE}/queue`);
  });

  it('a `rejected` load gets the same route back', () => {
    renderAt('rejected');

    expect(screen.getByRole('link').getAttribute('href')).toBe(`/operator/${SITE}/queue`);
  });

  it('the copy no longer claims a navigation the screen does not perform', () => {
    renderAt('submitted');

    // The exact promise that shipped. It must not appear in ANY form — the
    // point is not that the wording changed but that nothing on this screen
    // says "wait, you are being taken somewhere" while nothing takes them.
    expect(screen.queryByText(/returning/i)).toBeNull();
    expect(screen.queryByText(/name picker/i)).toBeNull();
  });

  it('still says WHICH terminal state the load reached', () => {
    // Removing the lie must not remove the information. An operator arriving
    // here from a consumed check-in card needs to know the load was already
    // worked, not merely that it is over.
    renderAt('submitted');
    expect(screen.getByText(/submitted/i)).toBeTruthy();

    cleanup();
    renderAt('rejected');
    expect(screen.getByText(/rejected/i)).toBeTruthy();
  });
});

// ADR-0090 C — the void is offered exactly where it is legal.
//
// `voidLoad` accepts only the OPEN_DOCK_STATUSES set, and an affordance offered
// where the server would refuse it is the ADR-0065 Am.1 dead-end shape: the
// operator taps, gets an opaque refusal, and learns nothing. The guard has to be
// at the OFFER, not only at the write.
describe('ADR-0090 C — where the void is offered', () => {
  it.each(['arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished'] as const)(
    'offers the void on the open-dock status %s',
    (status) => {
      renderAt(status);
      expect(screen.getByTestId('void-panel')).toBeTruthy();
    },
  );

  it.each(['submitted', 'rejected'] as const)(
    'does NOT offer the void on the terminal status %s',
    (status) => {
      // Past `submitted` the load has left the floor's hands and may already sit
      // on an MRC invoice. Correcting that is ADR-0073's manager territory.
      renderAt(status);
      expect(screen.queryByTestId('void-panel')).toBeNull();
    },
  );
});
