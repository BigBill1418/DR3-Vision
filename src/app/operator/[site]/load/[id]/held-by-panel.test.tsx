// @vitest-environment jsdom
//
// ADR-0082 Amendment 1 — the copy for a LOST RACE actually reaches the operator.
//
// ## The defect this pins, which shipped in the first cut of ADR-0082
//
// `takeover.error_moved` was translated into en/es/ur and selected like this:
//
//     catch (e) {
//       const reason = e instanceof Error ? e.message : '';
//       setError(reason.includes('load_claim_moved') ? 'takeover.error_moved' : 'takeover.error');
//     }
//
// which directly contradicted `use-claim-loss-guard.ts`, sitting in the same
// directory and justifying its own existence with the fact that **a Server
// Action's throw arrives at the browser with its message REDACTED in production
// builds**. Both cannot be true. Because the redaction is real, the string match
// could never fire live: `error_moved` was dead code in three locales, and every
// operator who lost a takeover race saw the generic "That did not go through.
// Try again." — an invitation to retry a contest that is already settled, which
// is the exact loop ADR-0082 D5 declines to queue.
//
// It had no test. That is why it survived review of the code and died only on
// review of the ADR.
//
// The fix is structural: the action RETURNS a discriminated outcome (return
// values are not redacted) and the panel switches on it. These tests assert the
// rendered TEXT, not the branch, because "the right branch ran" is what the
// broken version would also have claimed in a unit test of the reducer.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const { takeOverLoadAction } = vi.hoisted(() => ({ takeOverLoadAction: vi.fn() }));
vi.mock('../../actions', () => ({ takeOverLoadAction }));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

// The real provider needs a client context; the panel only uses `t`, so the
// dictionary is wired directly. Interpolation is the REAL `translate`, because
// half the point is that `{{name}}` gets substituted.
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

import { HeldByPanel } from './held-by-panel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function panel() {
  return render(
    <HeldByPanel
      siteCode="woodland"
      loadId="load-1"
      holderName="Alma Ruiz"
      heldSince="2026-08-06T18:00:00.000Z"
      sourceName="Kiefer Landfill"
      transporterName="Yellow Freight"
      bolNumber="B-1"
      status="in_progress"
      totalUnits={null}
      takeable
      locale="en"
    />,
  );
}

/** Tap Take over, then Yes. */
async function attemptTakeover() {
  fireEvent.click(screen.getByRole('button', { name: en.takeover.take_over }));
  fireEvent.click(screen.getByRole('button', { name: en.takeover.confirm_yes }));
}

// ┌─ WHAT THIS FILE LOCKS, AND WHAT IT DOES NOT ───────────────────────────────┐
// │ These tests prove the copy RENDERS today, and they catch a regression that │
// │ REMOVES the return-value path. They do NOT catch message-inspection being  │
// │ ADDED BACK: re-adding the string-match alongside the working return value  │
// │ leaves this file green at 7/7 (measured 2026-08-08), because the dead      │
// │ `catch` branch is never reached. The regression lock for that direction is │
// │ the structural assertion in `src/lib/loads/load-claim-surface.test.ts`     │
// │ ("reads the outcome from the RETURN VALUE, never from a thrown message").  │
// │ Keep both; they fail on opposite mistakes.                                 │
// └────────────────────────────────────────────────────────────────────────────┘

describe('ADR-0082 Am.1 — a lost race renders the MOVED copy, naming who won', () => {
  it('renders error_moved with the winner’s name, and never the generic retry copy', async () => {
    takeOverLoadAction.mockResolvedValue({ outcome: 'claim_moved', holderName: 'Bruno Vega' });
    panel();
    await attemptTakeover();

    const alert = await screen.findByRole('alert');
    // The literal sentence an operator reads. Asserting the rendered string, not
    // a key, means a future change that swaps the key for a plausible-looking
    // wrong one still fails here.
    expect(alert.textContent).toBe(
      'Bruno Vega took this load over first — it is theirs now, not yours. Nothing you entered was lost.',
    );
    // THE REGRESSION. The broken version rendered exactly this instead.
    expect(alert.textContent).not.toContain(en.takeover.error);
    // The name was interpolated, not left as a placeholder.
    expect(alert.textContent).not.toContain('{{name}}');
  });

  it('does not tell the operator to try again — a settled contest is not retryable', async () => {
    takeOverLoadAction.mockResolvedValue({ outcome: 'claim_moved', holderName: 'Bruno Vega' });
    panel();
    await attemptTakeover();
    await screen.findByRole('alert');
    expect(screen.queryByText(en.takeover.error)).toBeNull();
  });

  it('refreshes so the held-by header stops naming the operator who no longer has it', async () => {
    takeOverLoadAction.mockResolvedValue({ outcome: 'claim_moved', holderName: 'Bruno Vega' });
    panel();
    await attemptTakeover();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('falls back to the translated "another operator" when the row has no assignee', async () => {
    // `assigned_operator_id` is nullable, so `holderName` can legitimately be
    // null. The banner must still be a sentence, never "null took this load".
    takeOverLoadAction.mockResolvedValue({ outcome: 'claim_moved', holderName: null });
    panel();
    await attemptTakeover();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(en.takeover.unknown_holder);
    expect(alert.textContent).not.toContain('null');
  });
});

describe('ADR-0082 Am.1 — the other outcomes each say something specific', () => {
  it('a load closed out while the panel was open says so, not "try again"', async () => {
    takeOverLoadAction.mockResolvedValue({ outcome: 'not_open', holderName: 'Alma Ruiz' });
    panel();
    await attemptTakeover();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en.takeover.error_not_open);
  });

  it('a genuine THROW maps to the generic — the catch inspects nothing', async () => {
    // The three unreachable refusals and a real 500 land here. This is the ONLY
    // path that may show the generic copy, and it is reached without reading a
    // message — which is the entire correction.
    takeOverLoadAction.mockRejectedValue(
      new Error('An error occurred in the Server Components render.'),
    );
    panel();
    await attemptTakeover();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en.takeover.error);
  });

  it('a SUCCESSFUL takeover shows no error banner at all', async () => {
    takeOverLoadAction.mockResolvedValue({ outcome: 'taken', holderName: 'Alma Ruiz' });
    panel();
    await attemptTakeover();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: en.takeover.take_over })).toBeTruthy(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
