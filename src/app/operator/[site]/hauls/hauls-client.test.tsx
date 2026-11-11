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
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/operator/woodland/hauls',
}));
const startLoadReconciledAction = vi.fn();
vi.mock('../actions', () => ({
  startLoadAction: vi.fn(),
  startLoadReconciledAction: (...a: unknown[]) => startLoadReconciledAction(...a),
}));

vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { HaulsClient, pinnedRank, type HaulRowView } from './hauls-client';

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
    reconcilableExpectedLoadId: null,
    slotDayISO: null,
    // ADR-0099 — a live slot by default; the withdrawn cases pass it explicitly.
    cancelledAtISO: null,
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

// ── ADR-0096 ────────────────────────────────────────────────────────────────
//
// The 2026-08-11 PM incident. H-136980 (Speedy Delivery, Union City) was booked
// for 8/10, nobody checked it in, and the truck arrived on the 11th. The slot was
// live and unconsumed, so it reached neither the consumed branch nor the
// check-in branch, and fell to the bare "View only" card. Bill: "We are clicking
// it and it does nothing."
describe('ADR-0096 — a truck that arrived on a different day is not a dead end', () => {
  const late = () =>
    row({
      externalHaulId: 'H-136980',
      collectionSite: 'Speedy Delivery LLC - Union City',
      reconcilableExpectedLoadId: 'exp-h136980',
      slotDayISO: '2026-08-10',
    });

  it('THE INCIDENT: the card is no longer a bare read-only note', () => {
    list(late());
    expect(screen.queryByText(en.floor.hauls.view_only)).toBeNull();
    expect(rowList().getByRole('button')).toBeTruthy();
  });

  it('names the day it was booked for, so the operator can tell slots apart', () => {
    list(late());
    // The body already carries the docking date; this asserts the explicit
    // "booked for X — not today" line, which is the one that tells the operator
    // WHY the ordinary control is absent.
    expect(screen.getByText(/Booked for .*Aug 10.*not today/i)).toBeTruthy();
  });

  it('does NOT check in on the first tap — the second tap reads the slot back', () => {
    // One-tap would make this as easy to mis-fire as the ordinary check-in, on
    // the one state where mis-firing mints a load onto the wrong slot.
    list(late());
    fireEvent.click(rowList().getByRole('button'));
    expect(startLoadReconciledAction).not.toHaveBeenCalled();
    // The read-back names BOTH identifying facts, which is the whole point of
    // the second tap.
    expect(screen.getByText(/Check in H-136980, booked for .*Aug 10.*today\?/i)).toBeTruthy();
    expect(screen.getByText(new RegExp(en.floor.hauls.late_yes, 'i'))).toBeTruthy();
  });

  it('sends the slot’s OWN day AND haul number to the server on confirm', () => {
    // The values the server compares. A client that never read this slot can
    // produce neither, which is what makes the acknowledgement evidence.
    //
    // ADR-0127 added the haul number to what travels: this panel already read it
    // back to the operator, and leaving the weaker guarantee on the noisier
    // control would have been the wrong way round.
    list(late());
    fireEvent.click(rowList().getByRole('button'));
    fireEvent.click(screen.getByText(new RegExp(en.floor.hauls.late_yes, 'i')));
    expect(startLoadReconciledAction).toHaveBeenCalledWith(
      'woodland',
      'exp-h136980',
      '2026-08-10',
      'H-136980',
    );
  });

  it('cancelling backs out and writes nothing', () => {
    list(late());
    fireEvent.click(rowList().getByRole('button'));
    fireEvent.click(screen.getByText(new RegExp(en.floor.hauls.late_cancel, 'i')));
    expect(startLoadReconciledAction).not.toHaveBeenCalled();
    expect(screen.queryByText(new RegExp(en.floor.hauls.late_yes, 'i'))).toBeNull();
  });

  it('an UNDATED slot stays read-only — there is no day to confirm or check', () => {
    // Excluded deliberately: the server assert compares against the slot's day,
    // so a slot without one cannot produce an acknowledgement worth checking.
    list(row({ reconcilableExpectedLoadId: null, slotDayISO: null }));
    expect(screen.getByText(en.floor.hauls.view_only)).toBeTruthy();
    expect(rowList().queryByRole('button')).toBeNull();
  });

  it('a slot due TODAY still gets the ORDINARY check-in control, not this one', () => {
    // This used to read "…the ordinary ONE-TAP check-in — the friction is scoped
    // to the divergent state; the common path is untouched." ADR-0127 deliberately
    // ends that: the common path is exactly where the 2026-08-25 mis-card
    // happened, and a test whose title still promises one tap would pin the
    // defect as the contract. What survives is the real claim — the late-arrival
    // control is scoped to the late-arrival state and does not leak onto a slot
    // that is due today.
    list(row({ expectedLoadId: 'exp-live' }));
    expect(screen.getByText(en.floor.hauls.check_in)).toBeTruthy();
    expect(screen.queryByText(new RegExp(en.floor.hauls.late_cta, 'i'))).toBeNull();
  });
});

// ── ADR-0099 — the withdrawn card ──────────────────────────────────────────
//
// The audit's D-2. A slot MyMRC cancelled was INVISIBLE on the queue
// (`cancelled_at: null` predicate) and UNEXPLAINED here — it fell into the same
// "View only" branch as "no sibling" and "not today". Production 2026-08-11
// 22:04 PT: 69 auto-cancellations, 67 of them undone by a later scrape, 30 by
// the very next hourly pass. So the state the floor was told nothing about was,
// 97% of the time, a slot that was about to come back.
describe('ADR-0099 — a withdrawn slot says so, and says what to do', () => {
  const withdrawn = () =>
    row({
      externalHaulId: 'H-136699',
      slotDayISO: '2026-08-10',
      cancelledAtISO: '2026-08-10T18:00:00.000Z', // 11:00 AM PDT
    });

  it('THE DEFECT: it is no longer the bare "View only" card', () => {
    list(withdrawn());
    expect(screen.getByTestId('haul-withdrawn')).toBeTruthy();
    expect(screen.queryByText(en.floor.hauls.view_only)).toBeNull();
  });

  it('names WHEN MyMRC withdrew it, in Pacific', () => {
    list(withdrawn());
    // 18:00Z is 11:00 AM PDT. Rendering the container's UTC clock would say
    // 6:00 PM — the ADR-0065 Am.1 defect, on the field this card exists for.
    expect(document.body.textContent).toMatch(/11:00\s*AM/);
  });

  it('names who can act and from where, and offers NO control', () => {
    list(withdrawn());
    expect(document.body.textContent).toContain(en.floor.hauls.withdrawn_what_to_do);
    // `startInboundLoad` answers 409 `expected_load_cancelled`. A button here
    // would be a control whose only outcome is a refusal — what ADR-0074 Am.1
    // forbids, and the reason this is an EXPLAINED dead end and not a restore
    // button. It self-heals instead: the office re-adding the haul in MyMRC
    // brings the row back within the hour via the scrape's un-cancel path.
    expect(rowList().queryByRole('button')).toBeNull();
    expect(rowList().queryByRole('link')).toBeNull();
  });

  it('a consumed slot still routes even if the slot was later withdrawn', () => {
    // `open-loads.ts` rescues a started load regardless of what happens to its
    // parent slot, and this card must agree: the consumed branch is tested
    // FIRST, so a withdrawal cannot strand work already in progress.
    list(
      row({
        cancelledAtISO: '2026-08-10T18:00:00.000Z',
        consumedLoad: {
          status: 'in_progress',
          open: true,
          totalUnits: null,
          workedAtISO: null,
          loadId: 'load-9',
          holderUserId: VIEWER,
          holderName: 'Janette',
        },
      }),
    );
    expect(rowList().getByRole('link').getAttribute('href')).toContain('/load/load-9');
    expect(screen.queryByTestId('haul-withdrawn')).toBeNull();
  });
});

// 2026-11-10 Woodland — "when we tap the Haul, nothing happens". The pinned
// "Coming up" block held 27 cards and exactly ONE could start a load; the rest
// were worked, withdrawn or booked for another day, and an inert card looks the
// same as the live one until its last line is read. The block is ordered newest
// docking date first, so the one actionable truck sat wherever its date put it.
// Actionable cards now lead the block; within each group the server's order holds.
describe('2026-11-10 — the pinned block leads with what can be worked', () => {
  const worked = row({
    id: 'a2K-worked',
    externalHaulId: 'H-900002',
    dockingDateISO: '2026-11-11T12:00:00.000Z',
    consumedLoad: {
      status: 'submitted',
      open: false,
      totalUnits: 40,
      workedAtISO: '2026-11-10T17:00:00.000Z',
      loadId: 'load-2',
      holderUserId: VIEWER,
      holderName: 'Pablo',
    },
  });
  const withdrawn = row({
    id: 'a2K-withdrawn',
    externalHaulId: 'H-900008',
    cancelledAtISO: '2026-11-01T16:00:00.000Z',
  });
  const open = row({
    id: 'a2K-open',
    externalHaulId: 'H-900003',
    consumedLoad: {
      status: 'in_progress',
      open: true,
      totalUnits: null,
      workedAtISO: null,
      loadId: 'load-3',
      holderUserId: VIEWER,
      holderName: 'Pablo',
    },
  });
  const startable = row({ id: 'a2K-start', externalHaulId: 'H-900001', expectedLoadId: 'exp-1' });

  function pendingOrder(pending: HaulRowView[]) {
    render(
      <HaulsClient
        siteCode="woodland"
        view={{ q: undefined, page: 1, undated: false }}
        rows={[]}
        pending={pending}
        undatedCount={0}
        hasAnyHauls
        viewerUserId={VIEWER}
      />,
    );
    const block = screen.getAllByRole('list')[0]!;
    return within(block)
      .getAllByRole('listitem')
      .map((li) => li.textContent?.match(/H-\d+/)?.[0]);
  }

  // ADR-0074 Am.2 (PR-1) — the late-truck card has a WORKING control (the
  // ADR-0096 two-tap check-in), so it is not inert and must not sink below cards
  // that do nothing.
  const late = row({
    id: 'a2K-late',
    externalHaulId: 'H-900004',
    reconcilableExpectedLoadId: 'exp-late',
    slotDayISO: '2026-11-09',
  });

  it('THE INCIDENT: the startable truck is the first card, ahead of inert ones', () => {
    expect(pendingOrder([worked, withdrawn, open, startable])).toEqual([
      'H-900001',
      'H-900003',
      'H-900002',
      'H-900008',
    ]);
  });

  it('ranks: startable 0, open load 1, late-truck reconcile 2, inert 3', () => {
    expect(pinnedRank(startable)).toBe(0);
    expect(pinnedRank(open)).toBe(1);
    expect(pinnedRank(late)).toBe(2);
    expect(pinnedRank(worked)).toBe(3);
    expect(pinnedRank(withdrawn)).toBe(3);
    // A late slot with no haul number renders read-only, so it is inert.
    expect(pinnedRank({ ...late, externalHaulId: null })).toBe(3);
  });

  it('the late-truck card sits after open loads and ahead of every inert card', () => {
    expect(pendingOrder([worked, late, withdrawn, open, startable])).toEqual([
      'H-900001',
      'H-900003',
      'H-900004',
      'H-900002',
      'H-900008',
    ]);
  });

  it('no pinned card is hidden or dropped by the reorder', () => {
    const input = [worked, late, withdrawn, open, startable];
    const out = pendingOrder(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual(input.map((r) => r.externalHaulId).sort());
  });

  it('leaves the order alone when nothing is actionable', () => {
    expect(pendingOrder([withdrawn, worked])).toEqual(['H-900008', 'H-900002']);
  });

  it('the reconcile confirm panel is scrolled into view when it opens', () => {
    // jsdom has no `scrollIntoView`: stub it for this test only and restore it, so
    // nothing later in the worker inherits a patched prototype.
    const had = 'scrollIntoView' in Element.prototype;
    if (!had) Element.prototype.scrollIntoView = () => {};
    const scrollIntoView: MockInstance<Element['scrollIntoView']> = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    try {
      list(row({ reconcilableExpectedLoadId: 'exp-r', slotDayISO: '2026-11-03' }));
      fireEvent.click(rowList().getByRole('button'));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      scrollIntoView.mockRestore();
      if (!had) delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

// ADR-0144 — the late-truck control reports its failures by cause, like QueueRow.
describe('ADR-0144 — a failed late-truck check-in says WHY', () => {
  const lateRow = row({ reconcilableExpectedLoadId: 'exp-r', slotDayISO: '2026-11-09' });
  async function confirmWith(result: () => void) {
    result();
    list(lateRow);
    fireEvent.click(rowList().getByRole('button'));
    fireEvent.click(rowList().getByText(en.floor.hauls.late_yes));
    return screen.findByTestId('checkin-failure');
  }

  it('THE INCIDENT: a 401 says the session ended and offers sign-in back to /hauls', async () => {
    const notice = await confirmWith(() =>
      startLoadReconciledAction.mockResolvedValueOnce({
        ok: false,
        status: 401,
        reason: 'not_authenticated_as_operator',
      }),
    );
    expect(notice.textContent).toContain(en.floor.action_outcome.signed_out);
    expect(notice.textContent).not.toContain(en.floor.confirm_checkin.mismatch);
    const link = within(notice).getByRole('link', { name: en.floor.action_outcome.sign_in });
    expect(link.getAttribute('href')).toBe(
      '/operator/woodland?next=%2Foperator%2Fwoodland%2Fhauls',
    );
  });

  it('a real 409 is the card-changed copy', async () => {
    const notice = await confirmWith(() =>
      startLoadReconciledAction.mockResolvedValueOnce({
        ok: false,
        status: 409,
        reason: 'slot_day_mismatch',
      }),
    );
    expect(notice.textContent).toContain(en.floor.confirm_checkin.mismatch);
  });

  it('no network says no connection, not card changed', async () => {
    const notice = await confirmWith(() =>
      startLoadReconciledAction.mockRejectedValueOnce(new TypeError('Failed to fetch')),
    );
    expect(notice.textContent).toContain(en.floor.action_outcome.no_connection);
    expect(notice.textContent).not.toContain(en.floor.confirm_checkin.mismatch);
  });
});
