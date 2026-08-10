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

import { HeldByPanel, STATUS_KEY, STATUS_FALLBACK_KEY } from './held-by-panel';

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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0074 Amendment 1 — the panel must not LABEL a closed load as open.
//
// `STATUS_KEY` carried entries for the five OPEN dock statuses only, and every
// other `LoadStatus` — `submitted`, `verified`, `rejected`, `submitted_to_mymrc`,
// `processed`, `expected` — fell through `?? 'queue.open_status_in_progress'` to
// the label **"Counting"**.
//
// That fallback is not a cosmetic slip; it is the panel actively contradicting
// itself. On 2026-08-10 the Santa Rita operator was shown, on one screen: a load
// held by a colleague, the word "Counting", and a takeover control that was
// disabled — because `takeable` reads `TAKEOVER_STATUSES`, which correctly
// excludes `submitted`. The only reading available to the person on the dock was
// "someone is counting this right now and I am locked out", when the truth was
// "this was finished five days ago". They waited on a colleague who was not
// working.
//
// The panel already refuses to be silent (ADR-0082). This closes the other half:
// it must also refuse to be WRONG. Two changes, both asserted below — every
// status gets its own key, and the fallback stops naming a specific live
// activity.
// ─────────────────────────────────────────────────────────────────────────────

/** The panel as it stood on 2026-08-10: terminal load, held by someone else. */
function terminalPanel(status: 'submitted' | 'rejected' | 'verified') {
  return render(
    <HeldByPanel
      siteCode="woodland"
      loadId="load-1"
      holderName="Alma Ruiz"
      heldSince="2026-08-03T00:01:00.000Z"
      sourceName="Santa Rita Jail"
      transporterName="Ron Lawrence & Son"
      bolNumber="B-1"
      status={status}
      totalUnits={159}
      takeable={false}
      locale="en"
    />,
  );
}

describe('ADR-0074 Am.1 — terminal statuses are labelled honestly, never "Counting"', () => {
  it('THE MISLABEL: a `submitted` load is not described as being counted', () => {
    terminalPanel('submitted');

    // "Counting" alongside a disabled takeover is the reading that stalled the
    // floor. It must not appear for a load that is finished.
    expect(screen.queryByText(new RegExp(en.queue.open_status_in_progress, 'i'))).toBeNull();
    expect(screen.getByText(new RegExp(en.queue.open_status_submitted, 'i'))).toBeTruthy();
  });

  it('`rejected` and `verified` each say what they are', () => {
    // Asserted BEFORE the regex is built: `new RegExp(undefined)` is `/(?:)/`,
    // which matches every node on the page, so a missing key would otherwise
    // fail with "found multiple elements" — a message that hides the real cause.
    expect(en.queue.open_status_rejected).toBeTruthy();
    expect(en.queue.open_status_verified).toBeTruthy();

    terminalPanel('rejected');
    expect(screen.getByText(new RegExp(en.queue.open_status_rejected, 'i'))).toBeTruthy();

    cleanup();
    terminalPanel('verified');
    expect(screen.getByText(new RegExp(en.queue.open_status_verified, 'i'))).toBeTruthy();
  });

  it('every LoadStatus has its own label — no status falls back to another one', () => {
    // The structural half. Adding a status to the schema without a label here is
    // how the defect got in, so the guard is over the enum, not over a list a
    // future edit would forget to extend.
    const statuses = [
      'expected',
      'arrived',
      'weight_captured',
      'unload_started',
      'in_progress',
      'finished',
      'submitted',
      'verified',
      'rejected',
      'submitted_to_mymrc',
      'processed',
    ] as const;

    const labels = statuses.map((s) => {
      const key = STATUS_KEY[s];
      expect(key, `LoadStatus "${s}" has no STATUS_KEY entry`).toBeTruthy();
      return key;
    });
    // Distinct keys: two statuses sharing one is the mislabel by another route.
    expect(new Set(labels).size).toBe(statuses.length);
  });

  it('the fallback for an unknown status names no specific activity', () => {
    // A status this build has never heard of must read as "unknown", not as
    // "Counting" — the whole failure mode was a confident wrong answer.
    const key = STATUS_KEY['some_future_status' as keyof typeof STATUS_KEY] ?? STATUS_FALLBACK_KEY;
    expect(key).not.toBe('queue.open_status_in_progress');
    expect(key).toBe(STATUS_FALLBACK_KEY);
  });
});
