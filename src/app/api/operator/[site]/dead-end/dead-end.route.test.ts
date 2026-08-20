// ADR-0122 — the beacon endpoint, and the one state on it that pages.
//
// ## What this suite is guarding
//
// The route already existed (ADR-0100) and already refused to be told who the
// caller is. What ADR-0122 adds is a payload that reaches a PAGER, so the
// interesting questions are new ones: does a page fire for `no_live_controls`
// and for nothing else, is it withheld when there is no load to click through
// to, and can a client put arbitrary text into the log line by way of the
// disable-reason snapshot.
//
// ## Recorded red (each mutation applied to `route.ts`, one at a time)
//
//   - Dropping the `state === 'no_live_controls'` condition:
//       × pages ONLY for no_live_controls > a load_closed report does not page
//         → expected "spy" to not be called at all, but actually been called 1 times
//   - Dropping the `objectId !== null` condition:
//       × pages ONLY for no_live_controls > withholds the page when there is no load id
//         → expected "spy" to not be called at all, but actually been called 1 times
//   - Replacing `parseReasons(...)` with `(b['reasons'] ?? {}) as Record<string,string>`:
//       × the disable snapshot is validated > drops unknown control ids and unknown reasons
//       × the disable snapshot is validated > caps the snapshot so a client cannot post
//         a dictionary into the log
//       Tests  2 failed | 9 passed (11)
//
// ## Two of these cases could not fail when they were first written, and that is
// ## worth recording rather than quietly fixing
//
//   - `a load_closed report does not page` originally posted no `stage`. The
//     route's `if` has three conditions; the stage check refused the payload on
//     its own, so deleting the STATE check left the case green. It now sends a
//     valid stage and objectId so the state check is the only thing standing.
//   - `drops unknown control ids` originally used `toMatchObject`, which is a
//     SUBSET match: every asserted key was present in the unvalidated payload
//     too, alongside the three that should have been stripped. `toStrictEqual`
//     is what actually holds the line.
//
// Both were found by running the mutations rather than by reading the file,
// which is the only way this class of hole is ever found.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireOperatorForSite = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => vi.fn(async () => ({ user: { role: 'operator' } })));
const getLocale = vi.hoisted(() => vi.fn(async () => 'en'));
const recordDeadEnd = vi.hoisted(() => vi.fn());
const recordWriteRefusal = vi.hoisted(() => vi.fn());
const publishStageDeadEndAlert = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, outcome: 'sent' as const })),
);

vi.mock('@/lib/auth-helpers', () => ({ requireOperatorForSite }));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/i18n/get-locale', () => ({ getLocale }));
vi.mock('@/lib/observability/dead-end', async () => {
  // The UNIONS are real — mocking them would let a typo in the route's runtime
  // arrays pass, and those arrays are the fence that keeps a Prometheus label
  // bounded.
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/observability/dead-end');
  return { ...actual, recordDeadEnd, recordWriteRefusal };
});
vi.mock('@/lib/floor/dead-end-alert', () => ({ publishStageDeadEndAlert }));

import { POST } from './route';

const SITE = Promise.resolve({ site: 'woodland' });

function post(body: unknown) {
  return POST(
    new Request('https://dr3-vision.svdp.us/api/operator/woodland/dead-end', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: SITE },
  );
}

const TRAPPED = {
  surface: 'load_stage',
  state: 'no_live_controls',
  objectId: 'abaf1aae',
  stage: 'bol',
  reasons: {
    photo_capture: 'photo_present',
    photo_add_another: 'not_captured',
    bol_continue: 'no_photo',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorForSite.mockResolvedValue({ siteCode: 'woodland', userId: 'user-1' });
});

describe('the load_stage surface', () => {
  it('records the event with the stage and the snapshot, and answers 204', async () => {
    const res = await post(TRAPPED);
    expect(res.status).toBe(204);
    expect(recordDeadEnd).toHaveBeenCalledWith({
      surface: 'load_stage',
      state: 'no_live_controls',
      objectId: 'abaf1aae',
      // Resolved SERVER-SIDE. The payload never got to say who it was.
      siteCode: 'woodland',
      userId: 'user-1',
      role: 'operator',
      locale: 'en',
      stage: 'bol',
      disableReasons: TRAPPED.reasons,
    });
  });

  it('refuses a stage outside the closed set, without losing the event', async () => {
    await post({ ...TRAPPED, stage: 'stage-9; DROP' });
    // The event is still counted — a `no_live_controls` render is worth having
    // even from a client that sent a stage we do not recognise.
    expect(recordDeadEnd).toHaveBeenCalledOnce();
    expect(recordDeadEnd.mock.calls[0]?.[0]).toMatchObject({ stage: undefined });
    // But it does NOT page: without a stage the fingerprint cannot dedupe and the
    // title would name nothing.
    expect(publishStageDeadEndAlert).not.toHaveBeenCalled();
  });
});

describe('pages ONLY for no_live_controls', () => {
  it('pages for a trapped stage, with the ids resolved server-side', async () => {
    await post(TRAPPED);
    expect(publishStageDeadEndAlert).toHaveBeenCalledWith({
      siteCode: 'woodland',
      loadId: 'abaf1aae',
      stage: 'bol',
      disableReasons: TRAPPED.reasons,
    });
  });

  it('a load_closed report does not page', async () => {
    // ADR-0100's existing states are screens WITH a route out — a card and a
    // Link to the queue. They are dashboard rows, per ADR-0037. Paging on them
    // is how the one alert that matters gets muted.
    //
    // A VALID stage and objectId ride along deliberately. Without them the other
    // two conditions in the route's `if` would refuse this payload on their own,
    // and the case would pass with the state check deleted — which is what the
    // first cut of this test did, and why the recorded red above names it.
    await post({ surface: 'load', state: 'load_closed', objectId: 'abaf1aae', stage: 'bol' });
    expect(recordDeadEnd).toHaveBeenCalledOnce();
    expect(publishStageDeadEndAlert).not.toHaveBeenCalled();
  });

  it('withholds the page when there is no load id', async () => {
    const noId: Record<string, unknown> = { ...TRAPPED };
    delete noId['objectId'];
    await post(noId);
    expect(recordDeadEnd).toHaveBeenCalledOnce();
    // ADR-0036 asks for the most specific click available. A page whose click
    // lands on `/status/dr3-vision` would show Bill a green dashboard, which is
    // exactly what it showed for 90 minutes on 2026-08-20.
    expect(publishStageDeadEndAlert).not.toHaveBeenCalled();
  });

  it('a write refusal does not page', async () => {
    await post({ surface: 'load_stage', refusal: 'signed_out' });
    expect(recordWriteRefusal).toHaveBeenCalledOnce();
    expect(publishStageDeadEndAlert).not.toHaveBeenCalled();
  });
});

describe('the disable snapshot is validated', () => {
  it('drops unknown control ids and unknown reasons', async () => {
    await post({
      ...TRAPPED,
      reasons: {
        bol_continue: 'no_photo',
        'not-a-control': 'no_photo',
        photo_capture: 'because the moon was full',
        __proto__: 'pending',
      },
    });
    // EXACT, not `toMatchObject`. A subset match passes on the unvalidated
    // payload — every asserted key is present, plus the three that should have
    // been stripped. The first cut of this test used it and stayed green with the
    // validation deleted.
    const recorded = recordDeadEnd.mock.calls[0]?.[0] as { disableReasons?: unknown };
    expect(recorded.disableReasons).toStrictEqual({ bol_continue: 'no_photo' });
  });

  it('caps the snapshot so a client cannot post a dictionary into the log', async () => {
    const flood: Record<string, string> = {};
    for (let i = 0; i < 500; i++) flood[`ctrl_${i}`] = 'pending';
    await post({ ...TRAPPED, reasons: flood });
    const recorded = recordDeadEnd.mock.calls[0]?.[0] as { disableReasons?: object };
    // Every key was unknown, so the snapshot is empty and the field is omitted.
    expect(recorded.disableReasons).toBeUndefined();
  });

  it('a non-object reasons field is ignored rather than fatal', async () => {
    for (const reasons of ['nope', 42, null, ['pending']]) {
      vi.clearAllMocks();
      const res = await post({ ...TRAPPED, reasons });
      expect(res.status).toBe(204);
      expect(recordDeadEnd).toHaveBeenCalledOnce();
    }
  });
});

describe('the instrument cannot break the screen it measures', () => {
  it('answers the guard status when the session is dead, and never a body', async () => {
    requireOperatorForSite.mockRejectedValue(new Response(null, { status: 401 }));
    const res = await post(TRAPPED);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(publishStageDeadEndAlert).not.toHaveBeenCalled();
  });

  it('still answers 204 when the pager throws', async () => {
    // `publishNtfy` never throws, but this route must not depend on that: a
    // telemetry endpoint that 500s because a page failed has turned an alerting
    // problem into a client-visible one.
    publishStageDeadEndAlert.mockRejectedValue(new Error('ntfy exploded'));
    const res = await post(TRAPPED);
    expect(res.status).toBe(204);
  });
});
