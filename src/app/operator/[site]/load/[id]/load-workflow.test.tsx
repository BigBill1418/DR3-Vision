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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LoadStatus } from '@prisma/client';
import en from '@/i18n/locales/en/operator.json';

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
// ADR-0090 Am.1 B — same reason again: the review panel reaches for
// `../../actions` and `@/lib/offline-queue` at module load. Its own behaviour is
// pinned in `review-panel.test.tsx`; this suite exercises the dispatch branch.
vi.mock('./review-panel', () => ({
  ReviewPanel: ({ onClose }: { onClose: () => void }) =>
    React.createElement(
      'div',
      { 'data-testid': 'review-panel' },
      React.createElement('button', { 'data-testid': 'review-close', onClick: onClose }, 'close'),
    ),
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
      load={{
        id: 'load-1',
        status,
        unload_started_at: null,
        total_units: 159,
        weight_lbs: 21000,
        // ADR-0109 — counts replaced the deduped `photo_kinds` array. One BOL
        // photo held, which is what `['bol']` meant here.
        photo_counts: { bol: 1 },
        // ADR-0124 — the stage dispatch reads server facts, and this fixture's
        // `arrived` case is the one that changes meaning: with a BOL photo held
        // and no recorded skip it is the WEIGHT stage, where it used to be BOL
        // until a client latch flipped.
        weight_skipped: false,
        stacks: [],
      }}
      operatorName="Marisol"
    />,
  );
}

/** The stage set — the seven stages, not the terminal screens. */
const OPEN_STAGES = [
  'arrived',
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

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

// Audit D-4 — the OTHER half of the same enum.
//
// ADR-0074 Am.1 fixed `submitted` / `rejected` above and left the rest of
// `LoadStatus` on a branch that was, in its entirety:
//
//     return <p>{t('workflow.unhandled_status', { status: load.status })}</p>;
//
// — a bare paragraph interpolating a raw enum token ("Unhandled status: voided"),
// no Link, no button, not even a wrapping element, translated just as uselessly
// into Spanish and Urdu. Its sibling three lines above carried the comment "A
// dead end with reassuring copy is worse than a bare dead end" and a route.
//
// It is REACHABLE. `voidLoad` sets `status: 'voided'` and NULLs
// `expected_load_id` but leaves `assigned_operator_id` intact, so the voiding
// operator stays the holder, `heldByOther` is false, and one Back tap after the
// void redirect lands here. Production held 0 voided loads at 2026-08-11 22:04
// PT — the panel is live and simply unused. The first operator to use it hits
// this, which is why the test is written over the WHOLE non-stage set rather
// than over `voided` alone.
describe('Audit D-4 — every non-stage status gets a label and a route', () => {
  // The four statuses that fall past the `submitted`/`rejected` branch and past
  // `STAGE_STATUSES`. Listed explicitly so adding a status to the schema without
  // deciding what this screen does is a visible omission, not a silent one.
  const CLOSED_STATUSES = [
    'verified',
    'voided',
    'submitted_to_mymrc',
    'processed',
  ] as const satisfies readonly LoadStatus[];

  it.each(CLOSED_STATUSES)('`%s` renders a link to the queue', (status) => {
    renderAt(status);
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/operator/${SITE}/queue`);
  });

  it.each(CLOSED_STATUSES)('`%s` never renders the raw enum token', (status) => {
    renderAt(status);
    // The literal that shipped. The status must be described in words an
    // operator can read, never echoed back as a database value.
    expect(document.body.textContent).not.toContain('Unhandled status');
    expect(document.body.textContent).not.toContain(`: ${status}`);
  });

  it('names the state in operator language, from the shared map', () => {
    renderAt('voided');
    // `queue.open_status_voided` — the label `held-by-panel.tsx` already had and
    // this branch did not. Asserted through the catalogue rather than by string
    // literal, so a copy edit moves the test with the product.
    expect(document.body.textContent).toContain(en.queue.open_status_voided);
  });

  it('a status this build has never heard of is admitted, not guessed', () => {
    // The `open-loads.tsx` defect in the other direction: its local copy of the
    // map fell back to "Counting", telling an operator a closed load was being
    // counted right now. Ignorance is the honest floor.
    renderAt('some_future_status' as LoadStatus);
    expect(document.body.textContent).toContain(en.queue.open_status_unknown);
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/operator/${SITE}/queue`);
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

// ADR-0090 Amendment 1 (B) — the back control, and where it goes.
//
// JT: "if you want to go back to fix or check what you entered is correct,
// vision doesn't let you." The workflow is forward-only and structurally so —
// stage dispatch is `load.status` plus three ONE-WAY client latches (`bolDone`,
// `weightSkipped`, `showReject`), of which only `showReject` had a control that
// reset it. There was no back-edge anywhere in the state machine.
//
// These tests assert the rendered CONTROL and the swap it performs, not a state
// flag: a component that merely *decided* to offer a way back is what shipped.
describe('ADR-0090 Am.1 — every stage offers a way to check what was entered', () => {
  it.each(OPEN_STAGES)('offers the review control on the stage %s', (status) => {
    renderAt(status);
    expect(screen.getByTestId('review-open')).toBeTruthy();
  });

  it.each(['submitted', 'rejected'] as const)(
    'does NOT offer it on the terminal screen %s',
    (status) => {
      // Not a stage. The load has left the floor's hands; the only offer there
      // is the route back to the queue (ADR-0074 Am.1, above).
      renderAt(status);
      expect(screen.queryByTestId('review-open')).toBeNull();
    },
  );

  it.each(OPEN_STAGES)('opening the review REPLACES the stage on %s', (status) => {
    // Replaces rather than stacks below it. The panel is a full read of the load
    // and the stage's primary action is a forward move — showing both at once is
    // how an operator taps Finish while reading a total they came here to doubt.
    renderAt(status);
    fireEvent.click(screen.getByTestId('review-open'));

    expect(screen.getByTestId('review-panel')).toBeTruthy();
    expect(screen.queryByTestId('review-open')).toBeNull();
    // The void stays out of reach while reviewing: it is the loudest control on
    // the screen and this is the one view where the operator is reading rather
    // than deciding.
    expect(screen.queryByTestId('void-panel')).toBeNull();
  });

  it('closing the review puts the operator back on the stage they left', () => {
    renderAt('in_progress');
    fireEvent.click(screen.getByTestId('review-open'));
    fireEvent.click(screen.getByTestId('review-close'));

    expect(screen.queryByTestId('review-panel')).toBeNull();
    expect(screen.getByTestId('review-open')).toBeTruthy();
    expect(screen.getByTestId('void-panel')).toBeTruthy();
  });

  it('the reject sub-stage is left alone — it has its OWN back control', () => {
    // `StageReject` already resets `showReject`, and it is a decision screen
    // mid-commitment. Offering a second, differently-worded back from inside it
    // is two controls that have to agree about what "back" means.
    renderAt('unload_started');
    expect(screen.getByTestId('review-open')).toBeTruthy();
  });
});
