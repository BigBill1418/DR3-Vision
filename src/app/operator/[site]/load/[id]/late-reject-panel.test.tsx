// @vitest-environment jsdom
//
// ADR-0113 — the affordance that was not there on 2026-08-19.
//
// Bill: "we accepted a load as arrived — then found massive bed bugs — no path
// to go back and reject it."
//
// H-137759 (Ron Lawrence & Son) was accepted, the unload began, and the floor
// found the infestation past the only door out. The load was closed by
// hand-audited DB rectification under `system:h137759-bedbug-rejection`.
//
// These tests pin the OFFER. `load-workflow.test.tsx` pins WHERE it mounts and
// `load-service.reject.test.ts` pins what the server does with it; this file is
// the middle — what an operator can and cannot commit from a screen mid-count.
// They assert rendered TEXT and the arguments the action receives, not internal
// state: "the right branch ran" is what a broken version would also claim.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { rejectLoadAction } = vi.hoisted(() => ({ rejectLoadAction: vi.fn() }));
vi.mock('../../actions', () => ({ rejectLoadAction }));

const { claimLost } = vi.hoisted(() => ({ claimLost: vi.fn().mockResolvedValue(false) }));
vi.mock('./use-claim-loss-guard', () => ({ useClaimLossGuard: () => claimLost }));

const { pendingActionsForLoad } = vi.hoisted(() => ({
  pendingActionsForLoad: vi.fn().mockResolvedValue(0),
}));
vi.mock('@/lib/offline-queue', () => ({ pendingActionsForLoad }));

// The real `PhotoInput` reaches for the ADR-0086 grant mint and a camera. Its
// own behaviour is pinned in `photo-input.auth.test.tsx` /
// `photo-input.limit.test.tsx`. Here it is a button that reports a capture, so
// this suite can exercise the thing it is actually about: whether the panel will
// commit WITHOUT one.
vi.mock('./photo-input', () => ({
  PhotoInput: ({ onCaptured }: { onCaptured: () => void }) =>
    React.createElement('button', { 'data-testid': 'capture-photo', onClick: onCaptured }, 'photo'),
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

import { LateRejectPanel } from './late-reject-panel';

const SITE = 'woodland';
const LOAD = 'load-h137759';

/** Two live stacks and one already taken back by hand (ADR-0090 Am.1). */
const STACKS = [
  { id: 's1', stack_index: 1, unit_count: 12, count_mode: 'multiplier' as const, voided_at: null },
  { id: 's2', stack_index: 2, unit_count: 9, count_mode: 'multiplier' as const, voided_at: null },
  {
    id: 's3',
    stack_index: 3,
    unit_count: 40,
    count_mode: 'multiplier' as const,
    voided_at: '2026-08-19T18:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  claimLost.mockResolvedValue(false);
  pendingActionsForLoad.mockResolvedValue(0);
});

function panel(over: Partial<React.ComponentProps<typeof LateRejectPanel>> = {}) {
  return render(
    <LateRejectPanel siteCode={SITE} loadId={LOAD} stacks={STACKS} photoCount={0} {...over} />,
  );
}

async function openPanel(over: Partial<React.ComponentProps<typeof LateRejectPanel>> = {}) {
  panel(over);
  fireEvent.click(screen.getByTestId('late-reject-open'));
  // The queue read is async; let the withholding gate settle before asserting on
  // controls it can hide. Without this the suite would sometimes assert against
  // the fail-closed first frame and sometimes against the settled one.
  await waitFor(() => expect(screen.queryByTestId('late-reject-unsent')).toBeNull());
}

/** Fill everything the server requires: a category and an evidence photo. */
function fillValid(category = 'bedbugs') {
  fireEvent.change(screen.getByTestId('late-reject-category'), { target: { value: category } });
  fireEvent.click(screen.getByTestId('capture-photo'));
}

describe('LateRejectPanel — the two taps', () => {
  it('is collapsed to a single quiet control until the operator asks for it', () => {
    // The common case is finishing the load. A reject control competing with
    // "+1 mattress" is how a mis-tap becomes an irreversible one.
    panel();
    expect(screen.getByTestId('late-reject-open')).toBeTruthy();
    expect(screen.queryByTestId('late-reject-panel')).toBeNull();
  });

  it('opening the panel commits nothing', async () => {
    await openPanel();
    expect(screen.getByTestId('late-reject-panel')).toBeTruthy();
    expect(rejectLoadAction).not.toHaveBeenCalled();
  });

  it('cancelling collapses it again and commits nothing', async () => {
    await openPanel();
    fireEvent.click(screen.getByTestId('late-reject-cancel'));
    expect(screen.queryByTestId('late-reject-panel')).toBeNull();
    expect(rejectLoadAction).not.toHaveBeenCalled();
  });
});

describe('LateRejectPanel — the consequence, stated before anything is asked', () => {
  it('names the stacks and units that are about to be voided', async () => {
    // A count already taken is the thing this action destroys. An operator who
    // opened this panel on the way to "+1 mattress" should learn that from the
    // panel, not from the queue afterwards.
    await openPanel();
    // The WHOLE rendered sentence, not a substring. `toContain('2')` would pass
    // on any string with a 2 in it — including the wrong one this asserts
    // against — and the numbers are the entire point of the line.
    expect(screen.getByTestId('late-reject-consequence').textContent).toBe(
      en.load_reject.consequence_counted
        .replace('{{stacks}}', '2') // the two LIVE stacks
        .replace('{{units}}', '21'), // 12 + 9
    );
  });

  it('EXCLUDES stacks already taken back by hand', async () => {
    // s3 is voided and carries 40 units. Counting it would tell the operator
    // they are about to destroy 61 units of work when the real figure is 21 —
    // and the number is the whole reason this line exists.
    await openPanel();
    const text = screen.getByTestId('late-reject-consequence').textContent ?? '';
    expect(text).not.toContain('61');
    expect(text).not.toContain('40');
  });

  it('says so honestly when nothing has been counted yet', async () => {
    await openPanel({ stacks: [] });
    expect(screen.getByTestId('late-reject-consequence').textContent).toBe(
      en.load_reject.consequence_uncounted,
    );
  });
});

describe('LateRejectPanel — what the server would refuse, refused here first', () => {
  it('will not commit without a category', async () => {
    await openPanel();
    fireEvent.click(screen.getByTestId('capture-photo'));
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    expect(rejectLoadAction).not.toHaveBeenCalled();
  });

  it('will not commit without an evidence photo', async () => {
    // Mirrors the server's 422 `rejection_photo_required`. Enforced in BOTH
    // places on purpose: the server is the authority, and the button being
    // disabled is what stops an operator meeting a refusal they cannot act on.
    await openPanel();
    fireEvent.change(screen.getByTestId('late-reject-category'), {
      target: { value: 'bedbugs' },
    });
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    expect(rejectLoadAction).not.toHaveBeenCalled();
  });

  it('will not commit `other` without a note', async () => {
    // `other` with no note spends the category field and records nothing.
    await openPanel();
    fireEvent.change(screen.getByTestId('late-reject-category'), { target: { value: 'other' } });
    fireEvent.click(screen.getByTestId('capture-photo'));
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    expect(rejectLoadAction).not.toHaveBeenCalled();
  });

  it('commits `other` once the note is written', async () => {
    await openPanel();
    fireEvent.change(screen.getByTestId('late-reject-category'), { target: { value: 'other' } });
    fireEvent.click(screen.getByTestId('capture-photo'));
    fireEvent.change(screen.getByTestId('late-reject-note'), {
      target: { value: '  smells of diesel  ' },
    });
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    await waitFor(() => expect(rejectLoadAction).toHaveBeenCalledOnce());
    expect(rejectLoadAction).toHaveBeenCalledWith(SITE, LOAD, 'other', 'smells of diesel');
  });

  it('commits `bedbugs` with a photo and no note', async () => {
    // The H-137759 shape. `bedbugs` states a fact on its own; demanding prose
    // from someone in gloves at a dock buys nothing.
    await openPanel();
    fillValid();
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    await waitFor(() => expect(rejectLoadAction).toHaveBeenCalledOnce());
    expect(rejectLoadAction).toHaveBeenCalledWith(SITE, LOAD, 'bedbugs', null);
  });

  it('offers bedbugs FIRST in the reason list', async () => {
    await openPanel();
    const options = Array.from(
      screen.getByTestId('late-reject-category').querySelectorAll('option'),
    );
    // [0] is the "— Select —" placeholder.
    expect(options[1]?.getAttribute('value')).toBe('bedbugs');
  });
});

describe('LateRejectPanel — the offline ordering hazard', () => {
  it('WITHHOLDS the controls while the load has unsent writes, and says why', async () => {
    // `LOAD_ADD_STACK` and `LOAD_FINISH_UNLOAD` are replayable scopes; the
    // rejection is not. A stack tapped while the iPad was offline can replay
    // AFTER the rejection and would be the one write asserting that the refused
    // truck delivered units.
    //
    // A control that is merely ABSENT teaches the operator the feature is
    // broken. The sentence is the half that matters.
    pendingActionsForLoad.mockResolvedValue(2);
    panel();
    fireEvent.click(screen.getByTestId('late-reject-open'));
    await waitFor(() => expect(screen.getByTestId('late-reject-unsent')).toBeTruthy());
    expect(screen.getByTestId('late-reject-unsent').textContent).toBe(en.load_reject.unsent);
    expect(screen.queryByTestId('late-reject-category')).toBeNull();
    expect((screen.getByTestId('late-reject-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('still shows the consequence while withheld', async () => {
    // The operator is being asked to wait. Telling them what they are waiting to
    // do is the difference between a queue and a wall.
    pendingActionsForLoad.mockResolvedValue(1);
    panel();
    fireEvent.click(screen.getByTestId('late-reject-open'));
    await waitFor(() => expect(screen.getByTestId('late-reject-unsent')).toBeTruthy());
    expect(screen.getByTestId('late-reject-consequence')).toBeTruthy();
  });

  it('FAILS CLOSED when the queue cannot be read at all', async () => {
    // IndexedDB is unavailable in private mode and during SSR. An unreadable
    // queue is not an empty queue, and treating it as empty is exactly what
    // would let the ordering hazard through.
    pendingActionsForLoad.mockRejectedValue(new Error('IndexedDB unavailable'));
    panel();
    fireEvent.click(screen.getByTestId('late-reject-open'));
    await waitFor(() => expect(screen.getByTestId('late-reject-unsent')).toBeTruthy());
    expect(rejectLoadAction).not.toHaveBeenCalled();
  });
});

describe('LateRejectPanel — a refusal that is really a takeover', () => {
  it('does not show a redacted server message when the claim has moved', async () => {
    // ADR-0082 — a Server Action's message is redacted in production, so the
    // client cannot read why it was refused. Asked, not guessed: the guard
    // refreshes, the page re-renders as the held-by panel, and it NAMES the new
    // holder instead of showing an error nobody can act on.
    rejectLoadAction.mockRejectedValue(new Error('load_not_assigned_to_operator'));
    claimLost.mockResolvedValue(true);
    await openPanel();
    fillValid();
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    await waitFor(() => expect(claimLost).toHaveBeenCalled());
    expect(screen.queryByText(en.load_reject.failed)).toBeNull();
    expect(screen.queryByText('load_not_assigned_to_operator')).toBeNull();
  });

  it('shows a readable failure when the claim is intact', async () => {
    rejectLoadAction.mockRejectedValue(new Error('boom'));
    claimLost.mockResolvedValue(false);
    await openPanel();
    fillValid();
    fireEvent.click(screen.getByTestId('late-reject-confirm'));
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});
