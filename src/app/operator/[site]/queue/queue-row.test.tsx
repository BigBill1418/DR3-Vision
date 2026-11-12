// @vitest-environment jsdom
//
// ADR-0127 — the check-in card is confirmed before the truck is worked.
//
// `checkin-acknowledgement.test.ts` pins the SERVER's half: that the confirmed
// haul number is compared against the slot and a mismatch is refused. This file
// pins the operator's half, because a guard the thumb never reaches is a guard
// that does not exist — and the two halves fail independently. The 2026-08-25
// incident is the proof: every identifying fact was already ON the card
// (ADR-0090 D1's haul chip, the supplier, the carrier), and one tap committed to
// them anyway.
//
// What the tests below insist on, in order of how the incident happened:
//
//   1. the first tap does NOT check in;
//   2. the panel that appears NAMES the truck — haul, supplier, carrier;
//   3. the confirmed haul number is what travels to the server;
//   4. backing out writes nothing;
//   5. a refusal is SHOWN rather than swallowed (floor dead-end audit D-8).

import React from 'react';
import { afterEach, describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const startLoadAction = vi.fn();
vi.mock('../actions', () => ({
  startLoadAction: (...a: unknown[]) => startLoadAction(...a),
}));

// The sign-in control returns the operator to the screen they tapped on.
vi.mock('next/navigation', () => ({ usePathname: () => '/operator/woodland/queue' }));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { QueueRow } from './queue-row';

/** The two cards that sat adjacent on the Woodland queue on 2026-08-25. */
const LAKE_COUNTY = {
  haulLabel: 'H-138155',
  sourceLabel: 'Lake County Waste Solutions, Inc.',
  transporterLabel: 'Ron Lawrence & Son',
};

function mount(over: Partial<typeof LAKE_COUNTY> = {}) {
  render(
    <QueueRow siteCode="woodland" expectedLoadId="exp-h138155" {...LAKE_COUNTY} {...over}>
      <span>card body</span>
    </QueueRow>,
  );
}

/** The card itself — the first control on the row. */
const cardButton = () => screen.getAllByRole('button')[0]!;
const confirmButton = () => screen.getByText(new RegExp(en.floor.confirm_checkin.yes, 'i'));

beforeEach(() => startLoadAction.mockReset());
afterEach(cleanup);

describe('ADR-0127 — one tap no longer commits to a truck', () => {
  it('THE INCIDENT: the first tap does not check anything in', () => {
    mount();
    fireEvent.click(cardButton());
    expect(startLoadAction).not.toHaveBeenCalled();
  });

  it('reads the truck back: haul number, supplier, and carrier', () => {
    // All three, and the carrier specifically — DR3's own parent account versus
    // "Ron Lawrence & Son" is what most starkly separated the two cards, and it
    // was the dimmest line on the row.
    mount();
    fireEvent.click(cardButton());
    const panel = screen.getByTestId('queue-row-confirm');
    expect(panel.textContent).toContain('H-138155');
    expect(panel.textContent).toContain('Lake County Waste Solutions, Inc.');
    expect(panel.textContent).toContain('Ron Lawrence & Son');
    expect(panel.textContent).toContain(en.floor.confirm_checkin.question);
  });

  it('sends the CONFIRMED haul number to the server on the second tap', () => {
    // The value the server compares. It is the one the panel displayed, so a
    // card that describes a different slot than the server holds cannot be
    // confirmed into a load.
    mount();
    fireEvent.click(cardButton());
    fireEvent.click(confirmButton());
    expect(startLoadAction).toHaveBeenCalledWith('woodland', 'exp-h138155', 'H-138155');
  });

  it('backing out writes nothing and puts the panel away', () => {
    mount();
    fireEvent.click(cardButton());
    fireEvent.click(screen.getByText(new RegExp(en.floor.confirm_checkin.no, 'i')));
    expect(startLoadAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('queue-row-confirm')).toBeNull();
  });

  it('SHOWS a refusal instead of doing nothing (dead-end audit D-8)', async () => {
    // A refused write that renders nothing is the shape the floor audit named:
    // the tap does nothing, no sentence appears, and the operator taps again.
    // ADR-0144 — the refusal now ARRIVES as a value; a 409 is a real card change.
    startLoadAction.mockResolvedValueOnce({
      ok: false,
      status: 409,
      reason: 'haul_number_mismatch',
    });
    mount();
    fireEvent.click(cardButton());
    fireEvent.click(confirmButton());
    expect(await screen.findByText(en.floor.confirm_checkin.mismatch)).toBeTruthy();
  });

  // The inverse defect — a success reported as a failure — is pinned in
  // `src/lib/next-redirect.test.ts` rather than here. Asserting it through this
  // component is not possible: the re-thrown signal escapes the React transition
  // as an unhandled rejection and fails the run whether the code is right or
  // wrong, which would make the test say nothing about the code.
});

// 2026-11-10 Woodland "we tap the haul and nothing happens" — reproduced on an
// iPad-sized WebKit: a startable card whose top sat 213px above the bottom edge
// opened its confirm panel ENTIRELY below the fold (panel top 1039, Yes at 1195,
// viewport 1080). Nothing on screen changed, so the tap read as dead. The panel
// is the answer to the tap; it has to be where the operator is looking.
describe('the confirm panel is brought on screen when it opens', () => {
  // jsdom has no `scrollIntoView`. Install a stub only for this block and take it
  // away afterwards — the #319 version assigned the prototype and never restored
  // it, which leaked into every later test in the same worker.
  let scrollIntoView: MockInstance<Element['scrollIntoView']>;
  let installed = false;
  const proto = Element.prototype as Partial<Element>;
  beforeEach(() => {
    if (!proto.scrollIntoView) {
      proto.scrollIntoView = () => {};
      installed = true;
    }
    scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });
  afterEach(() => {
    scrollIntoView.mockRestore();
    if (installed) {
      delete proto.scrollIntoView;
      installed = false;
    }
  });

  it('scrolls the panel into view on the first tap', () => {
    mount();
    fireEvent.click(cardButton());
    const panel = screen.getByTestId('queue-row-confirm');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(panel);
  });

  it('does not scroll anything before the card is tapped', () => {
    mount();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

// ADR-0144 — 2026-11-10 Woodland, after #319: an idled-out session tapped Yes and
// was told "This card changed since the page loaded". The action threw a 401,
// production Next hid it behind a digest, and the catch printed the 409 copy for
// everything. Each failure class now gets its own sentence, and signing out gets
// a way back to the PIN screen that returns to this page.
describe('ADR-0144 — a failed check-in says WHY', () => {
  async function confirmWith(result: () => void) {
    result();
    mount();
    fireEvent.click(cardButton());
    fireEvent.click(confirmButton());
    return screen.findByTestId('checkin-failure');
  }

  it('THE INCIDENT: a 401 says the session ended, NOT that the card changed', async () => {
    const notice = await confirmWith(() =>
      startLoadAction.mockResolvedValueOnce({
        ok: false,
        status: 401,
        reason: 'not_authenticated_as_operator',
      }),
    );
    expect(notice.textContent).toContain(en.floor.action_outcome.signed_out);
    expect(notice.textContent).not.toContain(en.floor.confirm_checkin.mismatch);
  });

  it('the signed-out notice has a sign-in control that comes back to this screen', async () => {
    await confirmWith(() =>
      startLoadAction.mockResolvedValueOnce({ ok: false, status: 401, reason: 'x' }),
    );
    const link = screen.getByRole('link', { name: en.floor.action_outcome.sign_in });
    expect(link.getAttribute('href')).toBe(
      '/operator/woodland?next=%2Foperator%2Fwoodland%2Fqueue',
    );
    // ADR-0060 gloved-hand sizing; rule #10 — a link, never a form.
    expect(link.className).toContain('min-h-[56px]');
    expect(document.querySelector('form')).toBeNull();
  });

  it.each([
    ['403', { ok: false, status: 403, reason: 'not_an_operator' }],
    ['404', { ok: false, status: 404, reason: 'expected_load_not_found' }],
  ] as const)('a %s says this card cannot be checked in here', async (_s, value) => {
    const notice = await confirmWith(() => startLoadAction.mockResolvedValueOnce(value));
    expect(notice.textContent).toContain(en.floor.action_outcome.not_allowed);
    expect(notice.textContent).not.toContain(en.floor.confirm_checkin.mismatch);
  });

  it('a stale bundle after a deploy says the app was updated', async () => {
    const e = Object.assign(new Error('Server Action "ab" was not found on the server.'), {
      name: 'UnrecognizedActionError',
    });
    const notice = await confirmWith(() => startLoadAction.mockRejectedValueOnce(e));
    expect(notice.textContent).toContain(en.floor.action_outcome.app_updated);
  });

  it('no network says no connection (iPad Safari wording)', async () => {
    const notice = await confirmWith(() =>
      startLoadAction.mockRejectedValueOnce(new TypeError('Load failed')),
    );
    expect(notice.textContent).toContain(en.floor.action_outcome.no_connection);
  });

  it('an UNDEFINED result (success during a hard navigation) shows no failure notice', async () => {
    startLoadAction.mockResolvedValueOnce(undefined);
    mount();
    fireEvent.click(cardButton());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(startLoadAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('checkin-failure')).toBeNull();
  });

  it('an opaque server error is a plain failure, NOT a card change', async () => {
    const notice = await confirmWith(() =>
      startLoadAction.mockRejectedValueOnce(Object.assign(new Error('x'), { digest: '42' })),
    );
    expect(notice.textContent).toContain(en.floor.action_outcome.failed);
    expect(notice.textContent).not.toContain(en.floor.confirm_checkin.mismatch);
  });
});
