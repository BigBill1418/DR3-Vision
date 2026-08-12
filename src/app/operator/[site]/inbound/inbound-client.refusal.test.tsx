// @vitest-environment jsdom
//
// Audit D-8, `/inbound`. `errorMessage()` mapped `per_load_exists`,
// `office_owned` and a split regex — and nothing else — so the ADR-0065 day pin
// (422 `date_not_today`) and an expired session (401) both arrived as
// `floor.common.save_failed`.
//
// The day exposure here is narrower than on the other three surfaces and worth
// writing down, because it is the reason this is a stale-page fix rather than a
// day-picker fix: `inbound/page.tsx` calls `listFloorInboundDays(…, 1)` and
// `floor-inbound.ts` bounds the window to today with an explicit no-future
// upper bound, so the list NEVER offers a day the server would refuse. The only
// way to earn the 422 is to hold this page open across Pacific midnight — which
// is exactly what a reload fixes.
//
// See `count-client.refusal.test.tsx` for the shared repro.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';
import type { FloorInboundDayView } from '@/lib/loads/floor-inbound';

const { enqueueAction, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueAction: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueAction, isOfflineError, newIdempotencyKey }));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { InboundClient } from './inbound-client';

/**
 * One provisional day — the bridge aggregate awaiting floor confirmation, which
 * renders a Confirm button that posts in a single tap.
 */
const PROVISIONAL: FloorInboundDayView = {
  dateISO: '2026-08-11',
  isToday: true,
  totalUnits: 400,
  programUnits: 260,
  nonProgramUnits: 140,
  loadSourceType: 'mymrc_haul',
  provisional: true,
  floorConfirmed: false,
  confirmedByYou: false,
  officeOwned: false,
  confirmedAt: null,
  hasPerLoadCapture: false,
};

function serverAnswers(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

function renderInbound(): void {
  render(<InboundClient siteCode="woodland" initialRows={[PROVISIONAL]} />);
}

function confirm(): void {
  fireEvent.click(screen.getByRole('button', { name: en.floor.inbound.confirm }));
}

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineError.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('422 date_not_today', () => {
  it('names the day, and not the generic failure', async () => {
    serverAnswers(422, { error: 'date_not_today' });
    renderInbound();
    confirm();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.floor.conflicts.why_wrong_day);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
  });

  it('offers a reload that re-renders the day list from the server', async () => {
    serverAnswers(422, { error: 'date_not_today' });
    renderInbound();
    confirm();
    const reload = await screen.findByTestId('write-refusal-refresh');
    expect(reload.textContent).toBe(en.update_prompt.reload);
    fireEvent.click(reload);
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('write-refusal')).toBeNull());
  });

  it('does not claim the day is queued', async () => {
    serverAnswers(422, { error: 'date_not_today' });
    renderInbound();
    confirm();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(screen.queryByTestId('inbound-queued')).toBeNull();
    expect(enqueueAction).not.toHaveBeenCalled();
  });
});

describe('401', () => {
  it('says the sign-in expired, with no reload on offer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthenticated', { status: 401 })),
    );
    renderInbound();
    confirm();
    await waitFor(() => expect(screen.getByTestId('write-refusal')).toBeTruthy());
    expect(document.body.textContent).toContain(en.auth_login.error_session_expired);
    expect(document.body.textContent).not.toContain(en.floor.common.save_failed);
    expect(screen.queryByTestId('write-refusal-refresh')).toBeNull();
  });
});

describe('what the new branch must NOT swallow', () => {
  it('`per_load_exists` keeps its own sentence', async () => {
    serverAnswers(409, { error: 'per_load_exists' });
    renderInbound();
    confirm();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.inbound.err_per_load));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('`office_owned` keeps its own sentence', async () => {
    serverAnswers(409, { error: 'office_owned' });
    renderInbound();
    confirm();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.inbound.err_office));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });

  it('a 500 is still the generic failure', async () => {
    serverAnswers(500, {});
    renderInbound();
    confirm();
    await waitFor(() => expect(document.body.textContent).toContain(en.floor.common.save_failed));
    expect(screen.queryByTestId('write-refusal')).toBeNull();
  });
});
