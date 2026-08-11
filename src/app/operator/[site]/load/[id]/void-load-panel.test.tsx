// @vitest-environment jsdom
//
// ADR-0090 C — the affordance JT could not find.
//
// "I'm not able to fix the pending one under my name, it doesn't let me 0 it
// out... I fixed everybody else's."
//
// The reason she could not is structural: `addStack` refuses `unitCount < 1`, so
// a load cannot be zeroed, and no abandon path existed at any stage. These tests
// pin the OFFER — the guard has to live where the action is offered, because
// the server write itself is idempotent and a mis-tap into it succeeds quietly.
//
// They assert rendered TEXT and the arguments the action receives, not internal
// state: "the right branch ran" is what a broken version would also claim.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { voidLoadAction } = vi.hoisted(() => ({ voidLoadAction: vi.fn() }));
vi.mock('../../actions', () => ({ voidLoadAction }));
const { claimLost } = vi.hoisted(() => ({ claimLost: vi.fn().mockResolvedValue(false) }));
vi.mock('./use-claim-loss-guard', () => ({ useClaimLossGuard: () => claimLost }));

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

import { VoidLoadPanel } from './void-load-panel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  claimLost.mockResolvedValue(false);
});

function panel() {
  return render(<VoidLoadPanel siteCode="woodland" loadId="load-h136796" />);
}

function openPanel() {
  panel();
  fireEvent.click(screen.getByText(en.load_void.open));
}

describe('VoidLoadPanel', () => {
  it('is collapsed to a single quiet control until the operator asks for it', () => {
    // The common case is finishing the load. A void control competing with the
    // primary action is how a mis-tap becomes an irreversible one.
    panel();
    expect(screen.getByText(en.load_void.open)).toBeTruthy();
    expect(screen.queryByText(en.load_void.heading)).toBeNull();
  });

  it('takes TWO taps — opening the panel commits nothing', () => {
    openPanel();
    expect(screen.getByText(en.load_void.heading)).toBeTruthy();
    expect(voidLoadAction).not.toHaveBeenCalled();
  });

  it('will not commit until a reason is chosen', () => {
    // `voided` has no legal successor — there is no un-void — so a void with no
    // stated reason is an unexplained terminal state nobody can reconstruct.
    openPanel();
    const confirm = screen.getByText(en.load_void.confirm) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('sends the reason the operator asserted', async () => {
    // A mis-click and a no-show are DIFFERENT FACTS (ADR-0077 D4). Collapsing
    // them loses the only signal separating a UI problem from a carrier problem.
    openPanel();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wrong_haul' } });
    fireEvent.click(screen.getByText(en.load_void.confirm));
    await waitFor(() => expect(voidLoadAction).toHaveBeenCalledOnce());
    expect(voidLoadAction).toHaveBeenCalledWith('woodland', 'load-h136796', 'wrong_haul', null);
  });

  it('distinguishes a truck that never came from a mis-tap', async () => {
    openPanel();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'truck_never_arrived' } });
    fireEvent.click(screen.getByText(en.load_void.confirm));
    await waitFor(() => expect(voidLoadAction).toHaveBeenCalledOnce());
    expect(voidLoadAction.mock.calls[0]?.[2]).toBe('truck_never_arrived');
  });

  it('requires a note for "something else", matching the server 422', () => {
    // Enforced in BOTH places on purpose. The server is the authority; the
    // disabled button is what stops an operator meeting a refusal they cannot
    // act on — the ADR-0065 Am.1 dead-end shape.
    openPanel();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } });
    const confirm = screen.getByText(en.load_void.confirm) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(en.load_void.note_required)).toBeTruthy();
  });

  it('accepts "something else" once a note is written, and trims it', async () => {
    openPanel();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } });
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  driver took it to Eugene  ' },
    });
    fireEvent.click(screen.getByText(en.load_void.confirm));
    await waitFor(() => expect(voidLoadAction).toHaveBeenCalledOnce());
    expect(voidLoadAction).toHaveBeenCalledWith(
      'woodland',
      'load-h136796',
      'other',
      'driver took it to Eugene',
    );
  });

  it('backs out without committing', () => {
    openPanel();
    fireEvent.click(screen.getByText(en.load_void.cancel));
    expect(screen.queryByText(en.load_void.heading)).toBeNull();
    expect(voidLoadAction).not.toHaveBeenCalled();
  });

  it('defers to the claim-loss guard rather than showing a redacted message', async () => {
    // ADR-0082 — a Server Action's throw arrives with its message REDACTED in
    // production. If the claim moved while this iPad sat on the screen, the page
    // must re-render as the held-by panel and NAME the new holder.
    claimLost.mockResolvedValue(true);
    voidLoadAction.mockRejectedValue(new Error('redacted'));
    openPanel();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wrong_haul' } });
    fireEvent.click(screen.getByText(en.load_void.confirm));
    await waitFor(() => expect(claimLost).toHaveBeenCalled());
    expect(screen.queryByText(en.load_void.failed)).toBeNull();
  });

  it('surfaces a real failure when the claim is still held', async () => {
    voidLoadAction.mockRejectedValue(new Error('boom'));
    openPanel();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wrong_haul' } });
    fireEvent.click(screen.getByText(en.load_void.confirm));
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });

  it('offers all three reasons, and only those', () => {
    openPanel();
    const options = Array.from(
      (screen.getByRole('combobox') as HTMLSelectElement).options,
      (o) => o.value,
    );
    expect(options).toEqual(['', 'wrong_haul', 'truck_never_arrived', 'other']);
  });
});
