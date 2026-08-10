// @vitest-environment jsdom
//
// 2026-08-10 — the LIVE capture path had no auth classification at all.
//
// ## The half of the defect that lives on the client
//
// The server half is `load-photo-guard.ts`: an expired operator session was
// answered 403 instead of 401. Fixing that alone would have changed the screen
// from `mint failed (403)` to `mint failed (401)` and nothing else, because
// this component treats every non-ok mint identically:
//
//     if (!mintRes.ok) throw new Error(`mint failed (${mintRes.status})`);
//
// — which lands in the generic catch, sets `status: 'error'`, and paints a
// button reading "Retry rejection evidence". On 2026-08-10 the Woodland floor
// tapped that button repeatedly against a session that had already ended. No
// retry could ever have worked, nothing on the screen said "sign in", and the
// photo bytes were never handed to the offline queue — so when the operator
// finally gave up, the evidence was gone and the load stranded at
// `unload_started` with three photos and no rejection evidence.
//
// The DRAIN path has known how to do this since ADR-0078 G7: `isAuthResponse`
// in `offline-queue.ts` classifies 401 as `auth:`, which the floor chrome
// renders as a sign-in affordance. The live path — the one an operator is
// standing in front of — never learned it. These tests give it the same
// contract.
//
// ## Why the photo is queued but the stage does NOT advance
//
// Queued, because the bytes exist in exactly one place and a screen that
// discards them has lost evidence that is not recoverable (the whole premise of
// ADR-0006 and ADR-0078). Once queued, the drain engine's own sweep marks the
// row `auth:session_expired` within a second (`subscribeToEnqueue` retries
// immediately), and the chrome's badge says "Sign in to send 1 item".
//
// NOT advanced, unlike the offline path, because the operator cannot finish
// here: `rejectLoadAction` is a Server Action behind the same session that just
// expired, so enabling Submit would buy one honest failure a second, more
// confusing one — with a redacted message, which is the exact dead end
// ADR-0082 exists to remove. One instruction, once: sign in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { enqueueUpload, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueUpload: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueUpload, isOfflineError, newIdempotencyKey }));

// The real dictionary and the real interpolation — the assertions below are
// about the TEXT an operator reads, and a stubbed `t` would be measuring itself.
vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { PhotoInput } from './photo-input';

const onCaptured = vi.fn();

function shoot(): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['jpeg-bytes'], 'IMG_0001.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
}

/** Mint answers `status`; nothing past it should be reached on the auth path. */
function mintAnswers(status: number, body: unknown = 'unauthenticated'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      typeof body === 'string'
        ? new Response(body, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a 401 from the mint is a SIGN-IN, not a retry', () => {
  beforeEach(() => {
    mintAnswers(401);
    render(
      <PhotoInput loadId="load-1" kind="rejection" labelKey="rejection" onCaptured={onCaptured} />,
    );
    shoot();
  });

  // The literal string Bill photographed on the floor, in its 401 form. It must
  // not appear at all.
  it('never shows a bare "mint failed" retry', async () => {
    await waitFor(() => expect(enqueueUpload).toHaveBeenCalled());
    expect(document.body.textContent, 'the un-actionable retry text survived').not.toContain(
      'mint failed',
    );
    expect(screen.queryByText(/Retry rejection evidence/)).toBeNull();
  });

  it('tells the operator to sign in, naming what is waiting', async () => {
    await waitFor(() => expect(screen.getByRole('button').textContent).toMatch(/sign in/i));
    expect(screen.getByRole('button').textContent).toContain('rejection evidence');
    expect(document.body.textContent).toMatch(/sign-in expired/i);
  });

  // The residual that cost the floor its evidence: the bytes were never queued.
  it('hands the photo bytes to the offline queue so nothing is lost', async () => {
    await waitFor(() => expect(enqueueUpload).toHaveBeenCalledTimes(1));
    // `mock.calls` widens to `[]` on a no-parameter mock, so the first
    // argument has to be reached through `unknown` — same shape as
    // `firstData` in `grant-routes.test.ts`.
    const arg = (
      enqueueUpload.mock.calls as unknown as Array<
        [{ load_id: string; kind: string; blob: Blob; idempotency_key: string }]
      >
    )[0]?.[0];
    if (!arg) throw new Error('expected enqueueUpload to have been called');
    expect(arg.load_id).toBe('load-1');
    expect(arg.kind).toBe('rejection');
    expect(arg.blob.size, 'an empty blob is not evidence').toBeGreaterThan(0);
    // The key minted at the tap, so the eventual drain is the SAME write and
    // not a second one (ADR-0078 D3).
    expect(arg.idempotency_key).toBe('0000000000abc-0000000000000000key1');
  });

  it('does NOT advance the stage — Submit must not arm behind a dead session', async () => {
    await waitFor(() => expect(enqueueUpload).toHaveBeenCalled());
    expect(
      onCaptured,
      'the operator was armed to submit a reject that cannot land',
    ).not.toHaveBeenCalled();
  });
});

describe('what a 401 must NOT change', () => {
  // Guard-the-guard. If the new branch swallowed every failure, this suite
  // would be proving nothing: a 500 is a real error and still reads as one.
  it('a 500 is still a plain error with a retry', async () => {
    mintAnswers(500, 'boom');
    render(<PhotoInput loadId="load-1" kind="bol" labelKey="bol" onCaptured={onCaptured} />);
    shoot();
    await waitFor(() => expect(screen.getByRole('button').textContent).toMatch(/Retry BOL/));
    expect(document.body.textContent).toContain('mint failed (500)');
    expect(enqueueUpload, 'a server error is not an auth failure').not.toHaveBeenCalled();
  });

  // A 403 is authenticated-but-refused — a cross-site photo, or a non-operator.
  // Signing in again does not fix it, and offering a sign-in would be the same
  // species of wrong answer in the other direction.
  it('a 403 does NOT offer a sign-in', async () => {
    mintAnswers(403, 'forbidden');
    render(<PhotoInput loadId="load-1" kind="bol" labelKey="bol" onCaptured={onCaptured} />);
    shoot();
    await waitFor(() => expect(document.body.textContent).toContain('mint failed (403)'));
    expect(screen.getByRole('button').textContent).not.toMatch(/sign in/i);
  });

  it('an offline failure still queues AND advances, exactly as before', async () => {
    isOfflineError.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<PhotoInput loadId="load-1" kind="bol" labelKey="bol" onCaptured={onCaptured} />);
    shoot();
    await waitFor(() => expect(enqueueUpload).toHaveBeenCalledTimes(1));
    expect(onCaptured, 'the offline affordance regressed').toHaveBeenCalledTimes(1);
  });
});
