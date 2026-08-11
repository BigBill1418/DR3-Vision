// @vitest-environment jsdom
//
// ADR-0090 Amendment 1 (B) — the counting stage, after stacks became voidable.
//
// ## The monotonic index, and why it is not an implementation detail
//
// `@@unique(load_id, stack_index)` is a FULL unique index and stays that way.
// The next index is therefore computed over EVERY stack, voided ones included,
// so an index is never reused. Two things depend on that:
//
//   1. A reused index collides with the voided row and the operator's next
//      count is refused — the ADR-0078 D6 "it failed but it actually saved"
//      shape, inverted.
//   2. More importantly, an index that can be reused makes a replayed
//      `add_stack` onto a voided index indistinguishable from an honest first
//      write. `addStack` answers 409 there precisely BECAUSE monotonicity means
//      the only way to reach a voided index is a replay of the write that was
//      voided. Reuse would turn that guard into a false refusal of real counts.
//
// The old expression was `(stacks.at(-1)?.stack_index ?? 0) + 1`, which reads
// the LAST element and assumes the array is sorted ascending. It is, today, but
// the assumption is silent and the failure it produces is a lost or refused
// count. Computed from the maximum instead.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { addStackAction, finishUnloadAction } = vi.hoisted(() => ({
  addStackAction: vi.fn(),
  finishUnloadAction: vi.fn(),
}));
vi.mock('../../actions', () => ({ addStackAction, finishUnloadAction }));

const { claimLost } = vi.hoisted(() => ({ claimLost: vi.fn().mockResolvedValue(false) }));
vi.mock('./use-claim-loss-guard', () => ({ useClaimLossGuard: () => claimLost }));

vi.mock('@/lib/offline-queue', () => ({
  enqueueAction: vi.fn(),
  isOfflineError: () => false,
  newIdempotencyKey: () => 'key-1',
}));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);
  return { useT: () => t, useI18n: () => ({ t, locale: 'en' }) };
});

import { StageStacks } from './stage-stacks';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  claimLost.mockResolvedValue(false);
});

const VOIDED_AT = '2026-08-11T02:00:00.000Z';

function renderStacks(stacks: Parameters<typeof StageStacks>[0]['existingStacks']) {
  return render(
    <StageStacks
      siteCode="woodland"
      loadId="load-1"
      unloadStartedAt={null}
      existingStacks={stacks}
    />,
  );
}

describe('ADR-0090 Am.1 — the next stack index is monotonic over VOIDED stacks', () => {
  it('THE INDEX TRAP: the index after a voided top stack is the next one, not its own', async () => {
    renderStacks([
      { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: null },
      { id: 's2', stack_index: 2, unit_count: 9, count_mode: 'ledger', voided_at: VOIDED_AT },
    ]);

    fireEvent.click(screen.getByText(/\+ 1 mattress/i));

    await waitFor(() =>
      expect(addStackAction).toHaveBeenCalledWith('key-1', 'woodland', 'load-1', 3, 1, 'ledger'),
    );
  });

  it('does not depend on the list being sorted', async () => {
    // `at(-1)` read the last ELEMENT and called it the highest index. The
    // ordering happens to hold today (`orderBy: stack_index asc` in the page
    // select), which is exactly what makes the assumption dangerous — nothing
    // fails loudly when it stops holding.
    renderStacks([
      { id: 's3', stack_index: 3, unit_count: 5, count_mode: 'ledger', voided_at: null },
      { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: null },
    ]);

    fireEvent.click(screen.getByText(/\+ 1 mattress/i));

    await waitFor(() =>
      expect(addStackAction).toHaveBeenCalledWith('key-1', 'woodland', 'load-1', 4, 1, 'ledger'),
    );
  });
});

describe('ADR-0090 Am.1 — a voided stack is visible but not counted', () => {
  it('the running total excludes it', () => {
    renderStacks([
      { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: null },
      { id: 's2', stack_index: 2, unit_count: 9, count_mode: 'ledger', voided_at: VOIDED_AT },
    ]);

    // 20, not 29 — and 1 counted stack, not 2. The header is the number the
    // operator reconciles against the trailer in front of them.
    expect(screen.getByText(/1 stacks · 20 units total/i)).toBeTruthy();
  });

  it('the row still SHOWS, struck through', () => {
    // Hiding it would make the total unexplainable to the person who counted it
    // ("it says 20, I counted 29"), and the row is the evidence the count
    // happened. Soft, never a delete — the server keeps it for the same reason.
    renderStacks([
      { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: null },
      { id: 's2', stack_index: 2, unit_count: 9, count_mode: 'ledger', voided_at: VOIDED_AT },
    ]);

    expect(screen.getByTestId('stage-stack-s2').getAttribute('data-voided')).toBe('true');
    expect(screen.getByTestId('stage-stack-s1').getAttribute('data-voided')).toBe('false');
  });

  it('Finish is refused once every stack has been voided — a void is not a zero', () => {
    // The gate was `stacks.length === 0` and it now counts LIVE stacks, so
    // voiding everything returns the screen to its pre-count state rather than
    // offering a 0-unit finish.
    //
    // That is ADR-0090 D2.1 restated at the affordance: a truck that arrived
    // carrying nothing is a real delivery with a real count and belongs in
    // `submitted`; a load that was never a truck must not appear in a delivery
    // record at all, and its remedy is the VOID — one control further down this
    // same screen. Letting Finish through at zero would collapse the two, which
    // is how a phantom haul reaches MyMRC.
    renderStacks([
      { id: 's1', stack_index: 1, unit_count: 20, count_mode: 'ledger', voided_at: VOIDED_AT },
    ]);

    expect(screen.getByRole('button', { name: /finish unload/i }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
