// @vitest-environment jsdom
//
// ADR-0121 — RE-ENTRY to a stage whose photo is already on the server must leave
// the operator at least one live control.
//
// ## The production incident this is written from (2026-08-20, Woodland)
//
// Load `abaf1aae` (H-137810) was checked in at 12:36:25 PT and its BOL photo
// landed at 12:36:35. It then sat at status `arrived` for over 90 minutes while
// three operators took it over in turn, each landing on a screen with NOTHING
// they could tap. Bill: *"no response, totally locked up, totally unusable."*
//
// Three separately-reasonable decisions compose into it, and no single file is
// wrong on its own:
//
//   1. `load-workflow.tsx` gates the BOL step on `bolDone`, a CLIENT `useState`.
//      Taking the BOL photo does not move `load.status` (it stays `arrived`), so
//      any reload — or any takeover by the next operator — returns to stage 1.
//   2. `stage-bol.tsx` gated Continue on `hasFile`, also client `useState`, which
//      is `false` on every fresh mount no matter what the server holds.
//   3. `photo-input.tsx` disables capture once `count > 0` (ADR-0109, correct —
//      it stops a second identical-looking way to take the required photo), and
//      renders "add another" ONLY from `done`/`queued`. A fresh mount is `idle`.
//
// Capture disabled, add-another absent, Continue disabled. Zero live controls,
// and it SURVIVES A HARD REFRESH because the trapping state is a `load_photos`
// row in Postgres, not anything in the browser. Before ADR-0109 the screen had an
// accidental escape hatch — `initialCount` defaulted to 0, so capture stayed
// live and re-taking the photo re-armed Continue.
//
// ## Why this test mounts the REAL composition
//
// The defect lives in the SEAM between the three files; each is defensible read
// alone. A suite that stubs `PhotoInput` cannot see it — the disabled capture
// button is half the trap. So this renders `StageBol`/`StageDoor` with the real
// `PhotoInput` underneath and asserts on what a thumb can actually reach.
//
// ## Bands, not endpoints
//
// `photo-input.limit.test.tsx` mounts 0 and MAX (3). Production was at **1**,
// which is exactly the value neither endpoint covers. Every band 0..3 is
// asserted here so the interior cannot regress silently again.
//
// ## Recorded red (this file against 7567ef1, the live SHA)
//
//     × stage 1 (BOL) re-entry > photoCount=1 leaves at least one live control
//       → a re-entered stage offered the operator NOTHING to tap: expected 0 to be greater than 0
//     × stage 1 (BOL) re-entry > photoCount=2 leaves at least one live control
//       → a re-entered stage offered the operator NOTHING to tap: expected 0 to be greater than 0
//     × stage 1 (BOL) re-entry > photoCount=3 leaves at least one live control
//       → a re-entered stage offered the operator NOTHING to tap: expected 0 to be greater than 0
//     × stage 3 (door-open) re-entry > photoCount=1 leaves at least one live control
//       → a re-entered stage offered the operator NOTHING to tap: expected 0 to be greater than 0
//     × stage 3 (door-open) re-entry > photoCount=2 ... (same)
//     × stage 3 (door-open) re-entry > photoCount=3 ... (same)
//     × the operator can actually advance > BOL Continue commits on re-entry with a server photo
//       → expected "spy" to be called at least once
//     × the operator can actually advance > door-open Continue commits on re-entry
//       → expected "spy" to be called at least once
//
// `photoCount=0` passes on both sides before and after: a first visit was never
// broken, and a fix that changed it would be a different defect.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { enqueueUpload, isOfflineError, newIdempotencyKey } = vi.hoisted(() => ({
  enqueueUpload: vi.fn(async () => ({})),
  isOfflineError: vi.fn(() => false),
  newIdempotencyKey: vi.fn(() => '0000000000abc-0000000000000000key1'),
}));
vi.mock('@/lib/offline-queue', () => ({ enqueueUpload, isOfflineError, newIdempotencyKey }));

const { bolCapturedAction, doorOpenCapturedAction } = vi.hoisted(() => ({
  bolCapturedAction: vi.fn(async () => undefined),
  doorOpenCapturedAction: vi.fn(async () => undefined),
}));
vi.mock('../../actions', () => ({ bolCapturedAction, doorOpenCapturedAction }));

// Real dictionary — these assertions are about controls an operator reads.
vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { StageBol } from './stage-bol';
import { StageDoor } from './stage-door';

/**
 * Every control on the screen that a thumb can actually action.
 *
 * Deliberately counts BUTTONS rather than looking for one known testid: the
 * incident was the absence of any of three different controls, and naming one
 * of them here would let the other two vanish without the test noticing.
 */
function liveControls(): HTMLButtonElement[] {
  return screen
    .queryAllByRole('button')
    .filter((b): b is HTMLButtonElement => !(b as HTMLButtonElement).disabled);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('stage 1 (BOL) re-entry', () => {
  for (const photoCount of [0, 1, 2, 3]) {
    it(`photoCount=${photoCount} leaves at least one live control`, () => {
      render(
        <StageBol
          siteCode="woodland"
          loadId="load-1"
          onCaptured={vi.fn()}
          photoCount={photoCount}
        />,
      );
      expect(
        liveControls().length,
        'a re-entered stage offered the operator NOTHING to tap',
      ).toBeGreaterThan(0);
    });
  }
});

describe('stage 3 (door-open) re-entry', () => {
  for (const photoCount of [0, 1, 2, 3]) {
    it(`photoCount=${photoCount} leaves at least one live control`, () => {
      render(<StageDoor siteCode="woodland" loadId="load-1" photoCount={photoCount} />);
      expect(
        liveControls().length,
        'a re-entered stage offered the operator NOTHING to tap',
      ).toBeGreaterThan(0);
    });
  }
});

// A live control is necessary but not sufficient — it has to be the one that
// moves the load forward. This is the half that proves the floor is unblocked
// rather than merely offered something to press.
describe('the operator can actually advance', () => {
  it('BOL Continue commits on re-entry with a server photo', async () => {
    const onCaptured = vi.fn();
    render(<StageBol siteCode="woodland" loadId="load-1" onCaptured={onCaptured} photoCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(bolCapturedAction).toHaveBeenCalledWith('woodland', 'load-1'));
    await waitFor(() => expect(onCaptured).toHaveBeenCalled());
  });

  it('door-open Continue commits on re-entry', async () => {
    render(<StageDoor siteCode="woodland" loadId="load-1" photoCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: /start unload/i }));
    await waitFor(() => expect(doorOpenCapturedAction).toHaveBeenCalledWith('woodland', 'load-1'));
  });
});

// The guard must not become "always enabled": a FIRST visit with no photo on the
// server and nothing captured yet still has to refuse, or ADR-0060's forced-BOL
// rule is gone and a load can reach the dock timer with no paperwork.
describe('the forced-photo rule survives the fix', () => {
  it('BOL Continue stays refused on a first visit with no photo anywhere', () => {
    render(<StageBol siteCode="woodland" loadId="load-1" onCaptured={vi.fn()} photoCount={0} />);
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(bolCapturedAction).not.toHaveBeenCalled();
  });

  it('door-open Continue stays refused on a first visit with no photo anywhere', () => {
    render(<StageDoor siteCode="woodland" loadId="load-1" photoCount={0} />);
    expect(
      (screen.getByRole('button', { name: /start unload/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(doorOpenCapturedAction).not.toHaveBeenCalled();
  });
});
