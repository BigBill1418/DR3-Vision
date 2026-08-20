// @vitest-environment jsdom
//
// ADR-0122 — the detector, wired to the REAL screens.
//
// ## What this file is for, and why the pure-rule suite is not enough
//
// `src/lib/floor/stage-controls.test.ts` proves the verdict rule is right about
// reason sets somebody typed. That is exactly the test that would have passed all
// the way through 2026-08-20: the trap lived in the SEAM between `load-workflow`,
// `stage-bol` and `photo-input`, and every one of those files is defensible read
// alone. So this suite mounts the real compositions — the stage over the real
// `PhotoInput` — and asserts the detector's verdict against WHAT A THUMB CAN
// REACH, counted from the rendered DOM.
//
// That cross-check is the falsification. `liveControls()` below is deliberately
// the same helper `stage-reentry.test.tsx` uses: it counts enabled BUTTONS rather
// than naming a testid, because the incident was the absence of any of three
// different controls and naming one would let the other two vanish unnoticed. If
// the registry ever disagrees with the DOM — a control that stops registering, a
// `disabled` prop that stops reading its reason — these cases go red, and they go
// red for the right reason: the beacon fired on a screen with a live button, or
// stayed silent on a screen with none.
//
// ## Bands, not endpoints
//
// `photo-input.limit.test.tsx` mounts 0 and MAX (3). Production was at 1. Every
// band 0..3 is covered here for the same reason ADR-0121 gives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { enqueueUpload, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueUpload: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueUpload, isOfflineError, newIdempotencyKey }));

vi.mock('../../actions', () => ({
  bolCapturedAction: vi.fn(async () => undefined),
  doorOpenCapturedAction: vi.fn(async () => undefined),
  weightCapturedAction: vi.fn(async () => undefined),
  weightSkipAction: vi.fn(async () => undefined),
  rejectLoadAction: vi.fn(async () => undefined),
}));

vi.mock('./use-claim-loss-guard', () => ({ useClaimLossGuard: () => async () => false }));

// Real dictionary — these assertions are about controls an operator reads.
vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);
  return { useT: () => t, useLocale: () => 'en', useI18n: () => ({ t, locale: 'en' }) };
});

import { StageBol } from './stage-bol';
import { StageDoor } from './stage-door';
import { StageWeight } from './stage-weight';
import { StageReject } from './stage-reject';
import { StageDecision } from './stage-decision';
import { StageLivenessBoundary, __resetStageLiveness } from './stage-liveness';

/** Every control on the screen a thumb can actually action. See the header. */
function liveControls(): HTMLButtonElement[] {
  return screen
    .queryAllByRole('button')
    .filter((b): b is HTMLButtonElement => !(b as HTMLButtonElement).disabled);
}

let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetStageLiveness();
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Reports the boundary actually sent. Filters nothing — there is one endpoint. */
function beacons() {
  return posts.filter((p) => p.url.includes('/dead-end'));
}

/**
 * The cross-check, applied to whatever is currently rendered.
 *
 * Asserted in BOTH directions on every case, because a detector that only ever
 * over-fires and a detector that only ever under-fires are different defects and
 * a one-directional assertion catches one of them.
 */
async function expectVerdictMatchesDom() {
  const enabled = liveControls().length;
  if (enabled === 0) {
    await waitFor(() =>
      expect(
        beacons().length,
        'the screen had ZERO enabled controls and the detector stayed silent',
      ).toBe(1),
    );
  } else {
    // A negative needs a settling window, or it passes because the effect has
    // not run yet rather than because it decided not to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(
      beacons(),
      `the screen had ${enabled} enabled control(s) and the detector paged anyway`,
    ).toHaveLength(0);
  }
}

describe('stage 1 (BOL) — post-#286, every band is alive and silent', () => {
  for (const photoCount of [0, 1, 2, 3]) {
    it(`photoCount=${photoCount}`, async () => {
      render(
        <StageLivenessBoundary siteCode="woodland" loadId="load-1" stage="bol">
          <StageBol siteCode="woodland" loadId="load-1" photoCount={photoCount} />
        </StageLivenessBoundary>,
      );
      // The ADR-0121 fix is what makes this band alive; if it were reverted the
      // cross-check would flip to the dead branch and demand a beacon.
      expect(liveControls().length).toBeGreaterThan(0);
      await expectVerdictMatchesDom();
    });
  }
});

describe('stage 3 (door-open) — post-#286, every band is alive and silent', () => {
  for (const photoCount of [0, 1, 2, 3]) {
    it(`photoCount=${photoCount}`, async () => {
      render(
        <StageLivenessBoundary siteCode="woodland" loadId="load-1" stage="door">
          <StageDoor siteCode="woodland" loadId="load-1" photoCount={photoCount} />
        </StageLivenessBoundary>,
      );
      expect(liveControls().length).toBeGreaterThan(0);
      await expectVerdictMatchesDom();
    });
  }
});

describe('stage 2 (weight) — the SECOND live instance of the ADR-0121 trap', () => {
  // ADR-0121 recorded stage 2 as unaffected because it "escapes via its own None
  // button". True on the `choose` screen. The `add` sub-screen has NO way back to
  // `choose`, so an operator re-entering a load whose weight ticket is already on
  // the server and tapping "Add weight" lands on: capture withheld (ADR-0109),
  // "add another" unrendered (fresh mount is `idle`), Continue held by
  // `!hasPhoto` — which typing a weight cannot satisfy. It is the 2026-08-20 trap
  // exactly, one stage over, and it is still armed in main.
  //
  // ADR-0122 does not FIX it — this PR is render-side observability only, and a
  // behaviour change is not something to ship into a floor window. It makes it
  // visible, which is the whole thesis. The fix rides with the server-derived
  // stage work (ADR-0121 §Follow-ups item 2), which is a behaviour change and
  // waits for a before-noon window.
  it('choose screen is alive at every band', async () => {
    for (const photoCount of [0, 1, 2, 3]) {
      cleanup();
      __resetStageLiveness();
      posts = [];
      render(
        <StageLivenessBoundary siteCode="woodland" loadId={`wl-${photoCount}`} stage="weight">
          <StageWeight siteCode="woodland" loadId={`wl-${photoCount}`} photoCount={photoCount} />
        </StageLivenessBoundary>,
      );
      expect(liveControls().length).toBeGreaterThan(0);
      await expectVerdictMatchesDom();
    }
  });

  it('add screen with a server photo is a dead end, and the detector says so', async () => {
    render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-2" stage="weight">
        <StageWeight siteCode="woodland" loadId="load-2" photoCount={1} />
      </StageLivenessBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /add weight/i }));

    expect(liveControls(), 'stage 2 add-mode re-entry offers NOTHING to tap').toHaveLength(0);
    await expectVerdictMatchesDom();

    const [beacon] = beacons();
    expect(beacon?.url).toBe('/api/operator/woodland/dead-end');
    expect(beacon?.body).toMatchObject({
      surface: 'load_stage',
      state: 'no_live_controls',
      objectId: 'load-2',
      stage: 'weight',
      reasons: {
        photo_capture: 'photo_present',
        photo_add_another: 'not_captured',
        weight_continue: 'no_photo',
        weight_add: 'not_rendered',
        weight_none: 'not_rendered',
      },
    });
  });

  it('add screen on a FIRST visit is alive — capture is the way forward', async () => {
    render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-3" stage="weight">
        <StageWeight siteCode="woodland" loadId="load-3" photoCount={0} />
      </StageLivenessBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /add weight/i }));
    expect(liveControls().length).toBeGreaterThan(0);
    await expectVerdictMatchesDom();
  });
});

describe('stages that carry an unconditional escape stay silent', () => {
  it('stage 5b (reject) — Back is always live, even with the photo already on the server', async () => {
    render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-4" stage="reject">
        <StageReject siteCode="woodland" loadId="load-4" onCancel={vi.fn()} photoCount={1} />
      </StageLivenessBoundary>,
    );
    await expectVerdictMatchesDom();
  });

  it('stage 4 (decision) — Reject carries no disabled gate at all', async () => {
    render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-5" stage="decision">
        <StageDecision siteCode="woodland" loadId="load-5" onReject={vi.fn()} />
      </StageLivenessBoundary>,
    );
    await expectVerdictMatchesDom();
  });
});

describe('the beacon is an instrument, not a megaphone', () => {
  it('fires at most once per (stage, load) per page lifetime', async () => {
    const { rerender } = render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-6" stage="weight">
        <StageWeight siteCode="woodland" loadId="load-6" photoCount={1} />
      </StageLivenessBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /add weight/i }));
    await waitFor(() => expect(beacons()).toHaveLength(1));

    // React re-renders freely and a parent poll re-renders every child. Counting
    // renders would measure React, not the floor.
    for (let i = 0; i < 5; i++) {
      rerender(
        <StageLivenessBoundary siteCode="woodland" loadId="load-6" stage="weight">
          <StageWeight siteCode="woodland" loadId="load-6" photoCount={1} />
        </StageLivenessBoundary>,
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(beacons()).toHaveLength(1);
  });

  it('a DIFFERENT load in the same dead stage is a different event', async () => {
    render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-7" stage="weight">
        <StageWeight siteCode="woodland" loadId="load-7" photoCount={2} />
      </StageLivenessBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /add weight/i }));
    await waitFor(() => expect(beacons()).toHaveLength(1));
    cleanup();

    render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-8" stage="weight">
        <StageWeight siteCode="woodland" loadId="load-8" photoCount={2} />
      </StageLivenessBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /add weight/i }));
    await waitFor(() => expect(beacons()).toHaveLength(2));
    expect(beacons().map((b) => b.body['objectId'])).toEqual(['load-7', 'load-8']);
  });

  it('renders no DOM of its own', () => {
    const { container } = render(
      <StageLivenessBoundary siteCode="woodland" loadId="load-9" stage="decision">
        <span data-testid="only-child" />
      </StageLivenessBoundary>,
    );
    // Behaviour-neutrality, asserted rather than asserted-in-prose: a wrapper
    // element here would change every stage's layout on an iPad.
    expect(container.innerHTML).toBe('<span data-testid="only-child"></span>');
  });

  it('a stage mounted with no boundary above it does not throw or post', async () => {
    render(<StageBol siteCode="woodland" loadId="load-10" photoCount={0} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(beacons()).toHaveLength(0);
  });
});
