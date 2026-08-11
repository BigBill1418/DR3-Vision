// @vitest-environment jsdom
//
// ADR-0074 Amendment 1 — the "Coming up" card stops being a trap.
//
// `portal-hauls.test.ts` pins the DECISION (which rows carry a check-in target).
// This file pins what the operator's thumb actually finds, because the decision
// reaching the UI correctly is a separate claim from the decision being right —
// and the row shape here has three states now where it had two:
//
//   startable  → a <button> (the existing QueueRow / startLoadAction path)
//   consumed   → read-only, and it SAYS what was worked and when
//   not today  → read-only, and it says when the truck is due
//
// The two read-only states must be distinguishable. Collapsing them into one
// "View only" chip would tell the Santa Rita operator nothing more than the dead
// button did: the question on the dock was never "can I tap this", it was "where
// did my truck go".

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../actions', () => ({ startLoadAction: vi.fn() }));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { HaulsClient, type HaulRowView } from './hauls-client';

function row(over: Partial<HaulRowView> = {}): HaulRowView {
  return {
    id: 'a2K00001',
    externalHaulId: 'H-134743',
    status: 'Confirmed',
    type: 'General',
    transporterName: 'Ron Lawrence & Son',
    collectionSite: 'Santa Rita Jail',
    collectionSource: null,
    dockingDateISO: '2026-08-10T12:00:00.000Z',
    dockingAtISO: '2026-08-10T22:00:00.000Z',
    programUnits: 0,
    nonProgramUnits: 0,
    consumerDropoffUnits: null,
    expectedLoadId: null,
    consumedLoad: null,
    ...over,
  };
}

/**
 * Queries scoped to the RESULT LIST. The search bar above it renders its own
 * buttons, so a bare `queryByRole('button')` would conflate "the row is
 * tappable" with "this screen has a Search button" — the assertion would pass
 * for the wrong reason on the very case it exists to pin.
 */
function rowList() {
  return within(screen.getByRole('list'));
}

/** The signed-in operator, unless a test is specifically about somebody else. */
const VIEWER = 'op-pablo';

function list(r: HaulRowView, viewerUserId: string = VIEWER) {
  return render(
    <HaulsClient
      siteCode="woodland"
      view={{ q: undefined, page: 1, undated: false }}
      rows={[r]}
      pending={[]}
      undatedCount={0}
      hasAnyHauls
      viewerUserId={viewerUserId}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ADR-0074 Am.1 — a consumed haul renders read-only, never a button', () => {
  it('THE INCIDENT: the already-worked Santa Rita card has no tappable control', () => {
    // BOTH fields set on purpose — this is the exact prod state on 2026-08-10.
    // The read layer handed the UI a check-in target for a slot that was already
    // consumed, and the UI rendered the button because that is all it was asked
    // to look at. `portal-hauls.ts` now refuses to produce this pair, and the UI
    // refuses to honour it: two independent reasons the dead button cannot come
    // back, so neither layer is the single point of failure it was.
    list(
      row({
        expectedLoadId: 'exp-santa-rita',
        consumedLoad: {
          status: 'submitted',
          open: false,
          totalUnits: 159,
          workedAtISO: '2026-08-05T23:48:00.000Z',
          loadId: 'load-santa-rita',
          holderUserId: 'op-nate',
          holderName: 'Nate Cullison',
        },
      }),
    );

    // The row is not a button. `QueueRow` renders the whole card as one, so a
    // single button in this list IS the dead affordance.
    expect(rowList().queryByRole('button')).toBeNull();
    expect(screen.queryByText(en.floor.hauls.check_in)).toBeNull();
  });

  it('says what was worked and when — the answer the dock actually needed', () => {
    list(
      row({
        consumedLoad: {
          status: 'submitted',
          open: false,
          totalUnits: 159,
          workedAtISO: '2026-08-05T23:48:00.000Z',
          loadId: 'load-santa-rita',
          holderUserId: 'op-nate',
          holderName: 'Nate Cullison',
        },
      }),
    );

    // Units and date, not a bare "view only" chip.
    expect(screen.getByText(/159/)).toBeTruthy();
    expect(screen.getByText(/Aug 5/)).toBeTruthy();
  });

  it('an OPEN child never renders the dead check-in BUTTON', () => {
    // Amendment 1's property, unchanged by ADR-0091: the check-in affordance
    // (`QueueRow`, a <button>) must never appear over a consumed slot. ADR-0091
    // adds a LINK into the existing load, which is a different control with a
    // different destination — `queryByRole('button')` still has to be null.
    list(
      row({
        externalHaulId: 'H-135311',
        expectedLoadId: 'exp-open',
        consumedLoad: {
          status: 'in_progress',
          open: true,
          totalUnits: null,
          workedAtISO: null,
          loadId: 'load-open',
          holderUserId: VIEWER,
          holderName: 'Pablo Ledezma',
        },
      }),
    );

    expect(rowList().queryByRole('button')).toBeNull();
    expect(screen.queryByText(en.floor.hauls.check_in)).toBeNull();
  });
});

describe('ADR-0091 — an OPEN child is a route back in, not a dead end', () => {
  /** The state that stranded Pablo Ledezma on H-136311, 2026-08-11 06:46 PDT. */
  function openHeldBy(holderUserId: string | null, holderName: string | null) {
    return row({
      externalHaulId: 'H-136311',
      collectionSource: 'Costco-Innovel -Sacramento',
      consumedLoad: {
        status: 'in_progress',
        open: true,
        totalUnits: null,
        workedAtISO: null,
        loadId: 'load-costco',
        holderUserId,
        holderName,
      },
    });
  }

  it('THE INCIDENT: your OWN open load stops claiming another operator has it', () => {
    // The literal defect. Pablo started this load, came back to the hauls screen
    // to re-enter it, and was told a colleague held it — a sentence that is false
    // exactly when the reader is the holder.
    list(openHeldBy(VIEWER, 'Pablo Ledezma'));

    expect(screen.queryByText(new RegExp(en.floor.common.already_started, 'i'))).toBeNull();
    expect(screen.getByText(new RegExp(en.floor.common.resume_yours, 'i'))).toBeTruthy();
  });

  it('and it offers a link INTO the load, which is what "cannot finish it" meant', () => {
    list(openHeldBy(VIEWER, 'Pablo Ledezma'));

    expect(rowList().getByRole('link').getAttribute('href')).toBe(
      '/operator/woodland/load/load-costco',
    );
  });

  it("a colleague's open load names them and routes to the ADR-0082 takeover", () => {
    list(openHeldBy('op-janette', 'Janette Tomas'));

    expect(screen.getByText(/Janette Tomas/)).toBeTruthy();
    expect(rowList().getByRole('link').getAttribute('href')).toBe(
      '/operator/woodland/load/load-costco',
    );
  });

  it('an UNASSIGNED open load falls back to "another operator" — never to "yours"', () => {
    // `holderUserId === viewerUserId` must not be reached by two nulls. Telling
    // an operator an ownerless load is theirs is the same class of confident
    // falsehood this ADR deletes.
    list(openHeldBy(null, null));

    expect(screen.queryByText(new RegExp(en.floor.common.resume_yours, 'i'))).toBeNull();
    expect(screen.getByText(new RegExp(en.takeover.unknown_holder, 'i'))).toBeTruthy();
  });

  it('a WORKED slot is still read-only — Amendment 1 is not reverted', () => {
    // The regression guard in the other direction. `submitted` has left the
    // floor's hands; there is nothing to route back into.
    list(
      row({
        consumedLoad: {
          status: 'submitted',
          open: false,
          totalUnits: 159,
          workedAtISO: '2026-08-05T23:48:00.000Z',
          loadId: 'load-worked',
          holderUserId: VIEWER,
          holderName: 'Pablo Ledezma',
        },
      }),
    );

    expect(rowList().queryByRole('link')).toBeNull();
    expect(rowList().queryByRole('button')).toBeNull();
    expect(screen.getByText(/159/)).toBeTruthy();
  });

  it('a startable haul still renders the tap-to-check-in button', () => {
    // The control. A fix that removes every button has replaced one outage with
    // another.
    list(row({ expectedLoadId: 'exp-live' }));

    expect(rowList().getByRole('button')).toBeTruthy();
    expect(screen.getByText(en.floor.hauls.check_in)).toBeTruthy();
  });

  it('a haul that is real work but not TODAY reads as scheduled, not as worked', () => {
    // Neither field set: a live unconsumed sibling whose appointment is a future
    // Pacific day. This is what H-134743 was on 2026-08-03, when the tap that
    // started the whole incident was accepted.
    list(row({ externalHaulId: 'H-136912', expectedLoadId: null, consumedLoad: null }));

    expect(rowList().queryByRole('button')).toBeNull();
    expect(screen.queryByText(en.floor.hauls.check_in)).toBeNull();
    expect(screen.getByText(en.floor.hauls.view_only)).toBeTruthy();
  });
});
