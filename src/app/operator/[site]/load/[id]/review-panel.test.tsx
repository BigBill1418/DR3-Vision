// @vitest-environment jsdom
//
// ADR-0090 Amendment 1 (B) — "if you want to go back to fix or check what you
// entered is correct, vision doesn't let you."
//
// JT, Woodland, 2026-08-10. The workflow was forward-only and structurally so:
// stage dispatch is `load.status` plus three one-way client latches, all seven
// stages render at ONE url, and the floor chrome's Back pill goes to the hub by
// an explicit ADR-0065 decision never to use `router.back()`.
//
// This suite pins the half of the ask that is always safe — CHECKING — and the
// three guards on the half that is not.
//
// ## What these tests refuse to accept as a pass
//
// The corrections are money writes: a stack is billed and a weight reaches an
// MRC invoice. So every assertion here is about the OFFER, not about a branch
// flag. An affordance shown where the server would refuse it is the ADR-0065
// Am.1 dead-end shape — the operator taps, gets an opaque refusal, and learns
// nothing — and it is exactly what shipped last time a control was added
// without asking where it was legal.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LoadStatus } from '@prisma/client';

const { reopenLoadAction, voidStackAction, correctWeightAction } = vi.hoisted(() => ({
  reopenLoadAction: vi.fn(),
  voidStackAction: vi.fn(),
  correctWeightAction: vi.fn(),
}));
vi.mock('../../actions', () => ({ reopenLoadAction, voidStackAction, correctWeightAction }));

const { claimLost } = vi.hoisted(() => ({ claimLost: vi.fn().mockResolvedValue(false) }));
vi.mock('./use-claim-loss-guard', () => ({ useClaimLossGuard: () => claimLost }));

const { pendingActionsForLoad } = vi.hoisted(() => ({
  pendingActionsForLoad: vi.fn().mockResolvedValue(0),
}));
vi.mock('@/lib/offline-queue', () => ({ pendingActionsForLoad }));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);
  return { useI18n: () => ({ t, locale: 'en' }), useT: () => t };
});

import { ReviewPanel, type ReviewLoad } from './review-panel';

const SITE = 'woodland';

function loadView(over: Partial<ReviewLoad> = {}): ReviewLoad {
  return {
    id: 'load-1',
    status: 'in_progress',
    weightLbs: 21000,
    photoKinds: ['bol', 'weight_ticket'],
    stacks: [
      { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: null },
      { id: 's2', stack_index: 2, unit_count: 9, count_mode: 'ledger', voided_at: null },
    ],
    ...over,
  };
}

function renderPanel(over: Partial<ReviewLoad> = {}) {
  return render(<ReviewPanel siteCode={SITE} load={loadView(over)} onClose={() => {}} />);
}

beforeEach(() => {
  pendingActionsForLoad.mockResolvedValue(0);
  claimLost.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ADR-0090 Am.1 — CHECKING what you entered is always available', () => {
  it('shows the weight that was entered', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('review-weight').textContent).toMatch(/21,?000/));
  });

  it('says "no weight ticket" rather than showing a blank or a zero', async () => {
    // A blank row is indistinguishable from a rendering bug, and a 0 is a
    // WEIGHT — ADR-0077 D4 drew this line: "not recorded" is not zero.
    renderPanel({ weightLbs: null });
    await waitFor(() => {
      const text = screen.getByTestId('review-weight').textContent ?? '';
      expect(text).not.toMatch(/\b0\b/);
      expect(text.trim().length).toBeGreaterThan(0);
    });
  });

  it('says which photos were captured and which were not', async () => {
    renderPanel({ photoKinds: ['bol'] });
    await waitFor(() => {
      expect(screen.getByTestId('review-photo-bol').getAttribute('data-captured')).toBe('true');
      expect(screen.getByTestId('review-photo-door_open').getAttribute('data-captured')).toBe(
        'false',
      );
    });
  });

  it('lists the stacks and their running total', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('review-total').textContent).toMatch(/29/));
  });

  it('a voided stack stays VISIBLE but leaves the total', async () => {
    // Soft, never a delete — the operator did count it, and hiding the row would
    // make the running total unexplainable ("it says 20, I counted 29").
    renderPanel({
      stacks: [
        { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: null },
        {
          id: 's2',
          stack_index: 2,
          unit_count: 9,
          count_mode: 'ledger',
          voided_at: '2026-08-11T02:00:00.000Z',
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId('review-stack-s2').getAttribute('data-voided')).toBe('true');
      expect(screen.getByTestId('review-total').textContent).toMatch(/20/);
    });
  });
});

describe('ADR-0090 Am.1 — a correction is only offered where the server allows it', () => {
  it('the stack Remove is offered while `in_progress`', async () => {
    renderPanel({ status: 'in_progress' });
    await waitFor(() => expect(screen.getByTestId('review-stack-remove-s1')).toBeTruthy());
  });

  it.each(['weight_captured', 'unload_started', 'finished'] as const)(
    'the stack Remove is NOT offered on %s',
    async (status: LoadStatus) => {
      // `voidStack` refuses anything but `in_progress`. On a finished load the
      // route is Reopen first, which is audited as its own event — so a count
      // never changes after a finish without a reopen row in front of it.
      renderPanel({ status });
      await waitFor(() => expect(screen.getByTestId('review-panel')).toBeTruthy());
      expect(screen.queryByTestId('review-stack-remove-s1')).toBeNull();
    },
  );

  it('an UNACKED stack cannot be removed', async () => {
    // A `tmp-` id exists only in this tab. There is no server row to void, and
    // offering the control would produce a 404 the operator cannot act on.
    renderPanel({
      status: 'in_progress',
      stacks: [
        { id: 'tmp-3', stack_index: 3, unit_count: 4, count_mode: 'ledger', voided_at: null },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('review-stack-tmp-3')).toBeTruthy());
    expect(screen.queryByTestId('review-stack-remove-tmp-3')).toBeNull();
  });

  it('a stack that is ALREADY voided offers no second Remove', async () => {
    renderPanel({
      status: 'in_progress',
      stacks: [
        {
          id: 's1',
          stack_index: 1,
          unit_count: 20,
          count_mode: 'ledger',
          voided_at: '2026-08-11T02:00:00.000Z',
        },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('review-stack-s1')).toBeTruthy());
    expect(screen.queryByTestId('review-stack-remove-s1')).toBeNull();
  });

  it('Reopen is offered ONLY on `finished`', async () => {
    renderPanel({ status: 'finished' });
    await waitFor(() => expect(screen.getByTestId('review-reopen')).toBeTruthy());

    cleanup();
    renderPanel({ status: 'in_progress' });
    await waitFor(() => expect(screen.getByTestId('review-panel')).toBeTruthy());
    expect(screen.queryByTestId('review-reopen')).toBeNull();
  });

  it('Fix weight is NOT offered at `arrived` — the operator is still on that stage', async () => {
    renderPanel({ status: 'arrived' });
    await waitFor(() => expect(screen.getByTestId('review-panel')).toBeTruthy());
    expect(screen.queryByTestId('review-weight-fix')).toBeNull();
  });

  it('Fix weight IS offered once the load is past `arrived`', async () => {
    renderPanel({ status: 'in_progress' });
    await waitFor(() => expect(screen.getByTestId('review-weight-fix')).toBeTruthy());
  });
});

describe('ADR-0090 Am.1 — corrections wait for the queue to drain', () => {
  it('THE OFFLINE TRAP: no correction is offered while this load has unsent work', async () => {
    // The hazard is ordering, and it is silent. A queued `finish_unload` or
    // `add_stack` for this load replays LATER — so a correction made now can be
    // overwritten by a write the operator made minutes ago and has forgotten
    // about, with no error anywhere. The three corrections are online-only
    // (ADR-0090 D2.4's reasoning, same as the load void), so the honest place to
    // stop this is the OFFER, and the panel says why rather than going quiet.
    pendingActionsForLoad.mockResolvedValue(2);
    renderPanel({ status: 'finished' });

    await waitFor(() => expect(screen.getByTestId('review-unsent')).toBeTruthy());
    expect(screen.queryByTestId('review-reopen')).toBeNull();
    expect(screen.queryByTestId('review-weight-fix')).toBeNull();
  });

  it('CHECKING still works while there is unsent work', async () => {
    // The read is always safe, and it is the half JT asked for first.
    pendingActionsForLoad.mockResolvedValue(2);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('review-total').textContent).toMatch(/29/));
  });
});

describe('ADR-0090 Am.1 — the corrections reach the server', () => {
  it('Reopen calls the action with the site and the load', async () => {
    renderPanel({ status: 'finished' });
    await waitFor(() => expect(screen.getByTestId('review-reopen')).toBeTruthy());
    fireEvent.click(screen.getByTestId('review-reopen'));
    await waitFor(() => expect(reopenLoadAction).toHaveBeenCalledWith(SITE, 'load-1'));
  });

  it('Remove calls the action with the STACK id, not its index', async () => {
    // The index is positional and monotonic; the id is the row. Sending the
    // index would make a client whose list is one render stale void the wrong
    // stack, and both loads would look healthy afterwards.
    renderPanel({ status: 'in_progress' });
    await waitFor(() => expect(screen.getByTestId('review-stack-remove-s2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('review-stack-remove-s2'));
    await waitFor(() => expect(voidStackAction).toHaveBeenCalledWith(SITE, 'load-1', 's2'));
  });

  it('Fix weight sends an integer and refuses an out-of-range one client-side', async () => {
    renderPanel({ status: 'in_progress' });
    await waitFor(() => expect(screen.getByTestId('review-weight-fix')).toBeTruthy());
    fireEvent.click(screen.getByTestId('review-weight-fix'));

    const input = screen.getByTestId('review-weight-input');
    fireEvent.change(input, { target: { value: '200000' } });
    // Mirrors the server's 422. Enforced in BOTH places on purpose: the server
    // is the authority, and the disabled button is what stops an operator
    // meeting a refusal they cannot act on.
    expect(screen.getByTestId('review-weight-save').hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: '18500' } });
    fireEvent.click(screen.getByTestId('review-weight-save'));
    await waitFor(() => expect(correctWeightAction).toHaveBeenCalledWith(SITE, 'load-1', 18500));
  });
});
