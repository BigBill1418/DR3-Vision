// ADR-0127 — the predicate that separates a successful check-in from a refused
// one, tested where it can be tested.
//
// Its two floor callers (`queue-row.tsx`, `reconcile-row.tsx`) both catch around
// a server action and both must re-throw this signal. Asserting that through the
// components is not possible without the re-thrown rejection escaping the React
// transition as an unhandled error and failing the run — so the components pin
// that a REFUSAL is shown, and this file pins which errors are refusals.

import { describe, it, expect } from 'vitest';
import { isNextRedirectSignal } from './next-redirect';

describe('isNextRedirectSignal', () => {
  it('recognises the real signal a server-action redirect throws', () => {
    expect(
      isNextRedirectSignal(
        Object.assign(new Error('NEXT_REDIRECT'), {
          digest: 'NEXT_REDIRECT;replace;/operator/woodland/load/new-load;307;',
        }),
      ),
    ).toBe(true);
  });

  it('matches on the PREFIX — the digest carries a destination and a status', () => {
    // Equality against the bare tag would classify every real redirect as a
    // failure, which is the defect this predicate exists to prevent.
    expect(isNextRedirectSignal({ digest: 'NEXT_REDIRECT;push;/x;303;' })).toBe(true);
  });

  it('does NOT absorb a genuine refusal', () => {
    // A 409 from the acknowledgement guard must reach the operator's screen.
    expect(isNextRedirectSignal(new Error('409 haul_number_mismatch'))).toBe(false);
    expect(isNextRedirectSignal({ digest: 'NEXT_NOT_FOUND' })).toBe(false);
    expect(isNextRedirectSignal({ digest: 42 })).toBe(false);
    expect(isNextRedirectSignal(null)).toBe(false);
    expect(isNextRedirectSignal(undefined)).toBe(false);
    expect(isNextRedirectSignal('NEXT_REDIRECT')).toBe(false);
  });
});
