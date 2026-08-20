// @vitest-environment jsdom
//
// ADR-0124 — the stage the operator ACTUALLY SEES, from server facts alone.
//
// ## Why this file exists next to `stage-selection.test.ts`
//
// That file proves the rule. This one proves the rule is the one wired up. The
// 2026-08-20 incident lived in the seam between a correct dispatch intention and
// what the component did with it, and a pure-function suite is structurally
// unable to see a seam. So this mounts the REAL `LoadWorkflow` over the REAL
// stages and the REAL `PhotoInput`, and reads the heading a thumb would read.
//
// ## The scenarios, named the way the floor would name them
//
// Reload, takeover and re-entry are the same thing to this component: a fresh
// mount with the server's facts and no client state. That is exactly why they
// are one describe block with three names — the old dispatch failed all three
// for one reason, and a suite that tested only "reload" would have looked like
// coverage.
//
// ## Recorded red — this file against `main` at 3116cf2, before the change
//
//     × a reload of a load whose BOL photo is already on the server lands on the
//       WEIGHT stage
//       → Unable to find an element with the text: 2. Weight ticket
//     × a takeover by the next operator lands where the work actually is
//       → Unable to find an element with the text: 2. Weight ticket
//     × re-entry after the tab was closed does not ask for the BOL again
//       → Unable to find an element with the text: 2. Weight ticket
//     × a recorded weight skip survives the reload
//       → Unable to find an element with the text: 3. Door open
//     Tests  4 failed | 13 passed (17)
//
// All four failed with the BOL heading on screen instead — which is the
// incident, reproduced.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadStatus } from '@prisma/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { enqueueUpload, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueUpload: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({
  enqueueUpload,
  isOfflineError,
  newIdempotencyKey,
  enqueueAction: vi.fn(async () => ({})),
}));

const { bolCapturedAction, weightSkipAction, doorOpenCapturedAction } = vi.hoisted(() => ({
  bolCapturedAction: vi.fn(async () => undefined),
  weightSkipAction: vi.fn(async () => undefined),
  doorOpenCapturedAction: vi.fn(async () => undefined),
}));
vi.mock('../../actions', () => ({
  bolCapturedAction,
  weightSkipAction,
  doorOpenCapturedAction,
  weightCapturedAction: vi.fn(async () => undefined),
  rejectLoadAction: vi.fn(async () => undefined),
  beginUnloadAction: vi.fn(async () => undefined),
  addStackAction: vi.fn(async () => undefined),
  finishUnloadAction: vi.fn(async () => undefined),
  submitLoadAction: vi.fn(async () => undefined),
  addConcernAction: vi.fn(async () => undefined),
}));

vi.mock('./use-claim-loss-guard', () => ({ useClaimLossGuard: () => async () => false }));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);
  return { useT: () => t, useLocale: () => 'en', useI18n: () => ({ t, locale: 'en' }) };
});

import { LoadWorkflow } from './load-workflow';
import { __resetStageLiveness } from './stage-liveness';

/** The heading each stage renders. What a thumb would read, not a testid. */
const HEADING = {
  bol: '1. Bill of Lading',
  weight: '2. Weight ticket',
  door: '3. Door open',
  decision: '4. Inspect the load',
  stacks: '5. Count the units',
  finish: '6. Finish',
} as const;

function mount(over: {
  status?: LoadStatus;
  bol?: number;
  weightSkipped?: boolean;
  weightTicket?: number;
  doorOpen?: number;
}) {
  return render(
    <LoadWorkflow
      siteCode="woodland"
      load={{
        id: 'abaf1aae',
        status: over.status ?? 'arrived',
        unload_started_at: null,
        total_units: 159,
        weight_lbs: null,
        photo_counts: {
          ...(over.bol ? { bol: over.bol } : {}),
          ...(over.weightTicket ? { weight_ticket: over.weightTicket } : {}),
          ...(over.doorOpen ? { door_open: over.doorOpen } : {}),
        },
        weight_skipped: over.weightSkipped ?? false,
        stacks: [],
      }}
      operatorName="Marisol"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetStageLiveness();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('reload · takeover · re-entry — one mount, one set of server facts', () => {
  it('a reload of a load whose BOL photo is already on the server lands on the WEIGHT stage', () => {
    mount({ status: 'arrived', bol: 1 });
    expect(screen.getByText(HEADING.weight)).toBeTruthy();
    expect(screen.queryByText(HEADING.bol)).toBeNull();
  });

  it('a takeover by the next operator lands where the work actually is', () => {
    // A takeover is a fresh mount with someone else's session. The component
    // cannot tell it from a reload, and that is the point: neither carries the
    // first operator's client state, and the old dispatch treated the absence of
    // that state as "the BOL has not been taken".
    mount({ status: 'arrived', bol: 1 });
    expect(screen.getByText(HEADING.weight)).toBeTruthy();
  });

  it('re-entry after the tab was closed does not ask for the BOL again', () => {
    mount({ status: 'arrived', bol: 3 });
    expect(screen.getByText(HEADING.weight)).toBeTruthy();
  });

  it('a recorded weight skip survives the reload', () => {
    mount({ status: 'arrived', bol: 1, weightSkipped: true });
    expect(screen.getByText(HEADING.door)).toBeTruthy();
  });

  it('a FIRST visit still starts at the BOL — ADR-0060 is intact', () => {
    mount({ status: 'arrived', bol: 0 });
    expect(screen.getByText(HEADING.bol)).toBeTruthy();
  });
});

describe('the rest of the dispatch is unchanged', () => {
  const cases: Array<[LoadStatus, string]> = [
    ['weight_captured', HEADING.door],
    ['unload_started', HEADING.decision],
    ['in_progress', HEADING.stacks],
    ['finished', HEADING.finish],
  ];
  for (const [status, heading] of cases) {
    it(`${status} renders ${heading}`, () => {
      mount({ status, bol: 1 });
      expect(screen.getByText(heading)).toBeTruthy();
    });
  }

  it('a voided load still gets the closed-load card and its way back', () => {
    mount({ status: 'voided', bol: 1 });
    expect(screen.getByTestId('load-closed')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/operator/woodland/queue');
  });
});

describe('the operator can still move forward', () => {
  it('a first visit offers capture and refuses Continue — the forced-BOL contract', () => {
    // The two halves of stage 1 on a genuinely new load. If retiring the latch
    // had broken either, the floor would either lose its paperwork rule or lose
    // its way to satisfy it.
    mount({ status: 'arrived', bol: 0 });
    expect((screen.getByTestId('photo-capture') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(bolCapturedAction).not.toHaveBeenCalled();
  });

  it('a stage reached by re-entry still commits — advancing needs no client callback', async () => {
    // Advancing is the server's job now: the action revalidates the route and
    // the next render reads the facts again. What must still be true is that the
    // tap COMMITS. Asserted on the DOOR stage, reached here purely from server
    // facts (`weight_captured`), with a door photo already on the server — the
    // re-entry shape ADR-0121 armed and #286 made escapable.
    mount({ status: 'weight_captured', bol: 1 });
    const start = screen.getByRole('button', { name: /start unload/i }) as HTMLButtonElement;
    // It has to be LIVE first, or clicking it proves nothing about commitment.
    expect(start.disabled, 'nothing captured and no server photo — must refuse').toBe(true);

    cleanup();
    mount({ status: 'weight_captured', bol: 1, doorOpen: 1 });
    fireEvent.click(screen.getByRole('button', { name: /start unload/i }));
    await waitFor(() =>
      expect(doorOpenCapturedAction).toHaveBeenCalledWith('woodland', 'abaf1aae'),
    );
  });

  it('the weight "None" tap commits the skip that used to live only in the browser', async () => {
    mount({ status: 'arrived', bol: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^none$/i }));
    await waitFor(() => expect(weightSkipAction).toHaveBeenCalledWith('woodland', 'abaf1aae'));
  });
});

describe('ADR-0122 — the detector still sees the same screens', () => {
  it('a re-entered weight ADD screen with a server photo is still reported as a dead end', async () => {
    // This PR does not fix stage 2's `add` trap (ADR-0122 §Consequences); it must
    // not silently stop REPORTING it either. Retiring the latches changed which
    // stage renders, so the beacon's subject changed with it, and this is the
    // assertion that the instrument followed.
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        posts.push(String(init.body ?? ''));
        return new Response(null, { status: 204 });
      }),
    );
    mount({ status: 'arrived', bol: 1, weightTicket: 1 });
    fireEvent.click(screen.getByRole('button', { name: /add weight/i }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toContain('"state":"no_live_controls"');
    expect(posts[0]).toContain('"stage":"weight"');
  });
});
