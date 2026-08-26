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
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

const startLoadAction = vi.fn();
vi.mock('../actions', () => ({
  startLoadAction: (...a: unknown[]) => startLoadAction(...a),
}));

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
    startLoadAction.mockRejectedValueOnce(new Error('409 haul_number_mismatch'));
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
