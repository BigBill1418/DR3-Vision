// ADR-0074 Amendment 1 — the consumed-slot verdict, and the two surfaces that
// must both ask for it.
//
// This file has two halves and they fail on opposite mistakes:
//
//   1. BEHAVIOUR — `toConsumedLoad` classifies a child correctly. Cheap, and it
//      pins the `open` boundary, which is the field the UI branches on.
//   2. STRUCTURE — the queue page and the portal-haul list actually SELECT the
//      child. This is the half that matters, because the 2026-08-10 defect was
//      not a mis-classification: it was two queries that never asked the
//      question at all, so there was nothing to classify. A behavioural test of
//      a helper nobody calls is green while the floor is blocked.
//
// The structural half reads the source files. That is the same technique
// `src/lib/notify/no-direct-mail.test.ts` uses to hold a chokepoint, and it is
// used here for the same reason: the property is "every check-in surface goes
// through this", which is a claim about the codebase, not about one function.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toConsumedLoad, CONSUMED_SLOT_SELECT, type InboundChildRow } from './consumed-slot';
import { OPEN_DOCK_STATUSES } from './open-loads';

// ADR-0091 — the child now carries its id and its holder, because the card has to
// be able to route back into an open load and to tell WHOSE it is. The helper
// keeps each test naming only the fields it is actually about.
function child(over: Partial<InboundChildRow> = {}): InboundChildRow {
  return {
    id: 'load-under-test',
    status: 'in_progress',
    total_units: null,
    submitted_at: null,
    assigned_operator_id: 'op-holder',
    assigned_operator: { name: 'Holder Name' },
    ...over,
  };
}

describe('toConsumedLoad — free slot vs worked slot', () => {
  it('a slot with no child is FREE (null), which is what makes a row startable', () => {
    expect(toConsumedLoad(null)).toBeNull();
    expect(toConsumedLoad(undefined)).toBeNull();
  });

  it('THE INCIDENT: a submitted child reports its units and its submission date', () => {
    expect(
      toConsumedLoad(
        child({
          id: 'load-159',
          status: 'submitted',
          total_units: 159,
          submitted_at: new Date('2026-08-05T23:48:00Z'),
          assigned_operator_id: 'op-nate',
          assigned_operator: { name: 'Nate Cullison' },
        }),
      ),
    ).toEqual({
      loadId: 'load-159',
      status: 'submitted',
      open: false,
      totalUnits: 159,
      workedAt: new Date('2026-08-05T23:48:00Z'),
      holderUserId: 'op-nate',
      holderName: 'Nate Cullison',
    });
  });

  it('an open child is `open: true` and carries no submission instant to show', () => {
    const c = toConsumedLoad(child({ status: 'in_progress' }));
    expect(c?.open).toBe(true);
    expect(c?.workedAt).toBeNull();
  });

  it('`open` tracks OPEN_DOCK_STATUSES exactly — the two cannot drift apart', () => {
    // The mislabel in `held-by-panel.tsx` was a hand-maintained status list that
    // fell behind the enum. This asserts the derivation rather than a copy.
    for (const s of OPEN_DOCK_STATUSES) {
      expect(toConsumedLoad(child({ status: s }))?.open).toBe(true);
    }
    for (const s of [
      'submitted',
      'verified',
      'rejected',
      'submitted_to_mymrc',
      'processed',
    ] as const) {
      expect(toConsumedLoad(child({ status: s }))?.open).toBe(false);
    }
  });
});

describe('every check-in surface asks whether the slot is already consumed', () => {
  const SURFACES = [
    // The day-bounded floor queue. Blind on 2026-08-10 on the very day
    // H-134743's appointment came round.
    'src/app/operator/[site]/queue/page.tsx',
    // The open portal-haul list (ADR-0074), whose unbounded "Coming up" block
    // accepted the original seven-days-early check-in.
    'src/lib/loads/portal-hauls.ts',
  ];

  it.each(SURFACES)('%s selects the inbound_load child', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).toContain('inbound_load: { select: CONSUMED_SLOT_SELECT }');
  });

  it.each(SURFACES)('%s routes the verdict through the shared helper', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).toContain('toConsumedLoad');
  });

  it('the select names every field the card needs to speak AND to route', () => {
    // Dropping one of the first three leaves the surface able to say "already
    // worked" but not "159 units, submitted 5 Aug" — the half the dock actually
    // needed, and the half a narrower select would silently remove.
    //
    // ADR-0091 adds the other three. `id` is the route back into an open load;
    // `assigned_operator_id` + `assigned_operator.name` are how the card tells
    // YOUR load from a colleague's. Without them the card could only guess, and
    // what it guessed — "Already started by another operator" — was false
    // precisely when the reader was the holder (2026-08-11, H-136311).
    expect(Object.keys(CONSUMED_SLOT_SELECT).sort()).toEqual([
      'assigned_operator',
      'assigned_operator_id',
      'id',
      'status',
      'submitted_at',
      'total_units',
    ]);
  });

  // ADR-0091 — the surfaces that RENDER the card are not the same files as the
  // ones that QUERY it. The queue decides and draws in one server component; the
  // hauls screen queries in `portal-hauls.ts` and draws in a client component,
  // because `consumed-slot.ts` reaches `prisma` and cannot enter the browser
  // bundle. So the offer chokepoint needs its own list — and the fact that these
  // two lists differ is exactly why the decision has to be a shared function
  // rather than a convention.
  const OFFER_SURFACES = [
    'src/app/operator/[site]/queue/page.tsx',
    'src/app/operator/[site]/hauls/hauls-client.tsx',
  ];

  it.each(OFFER_SURFACES)('%s routes the OFFER through describeConsumedSlot', (path) => {
    // ADR-0074 Am.1 put identical blindness on both surfaces because the
    // classification was shared but the DECISION was not — each screen
    // re-derived what to render, and both re-derived it wrong. A third check-in
    // surface must come through this helper.
    expect(readFileSync(path, 'utf8')).toContain('describeConsumedSlot');
  });
});

// ADR-0090 C — a voided load must not hold its haul hostage.
//
// The whole point of the void is that the REAL truck can still check in. If a
// voided child kept its slot marked consumed, the floor would trade one dead end
// (a load that cannot be closed) for a worse one (a haul that can never be
// worked) — and the second is the exact failure ADR-0074 Am.1 was written about.
describe('a voided child does not consume the slot (ADR-0090 C)', () => {
  it('frees the slot when the child was voided', () => {
    expect(toConsumedLoad(child({ status: 'voided' }))).toBeNull();
  });

  it('still reports a genuinely worked slot as consumed', () => {
    // The guard must be narrow: `submitted` is real work and must stay consumed.
    expect(
      toConsumedLoad(
        child({
          status: 'submitted',
          total_units: 159,
          submitted_at: new Date('2026-08-10T22:49:35.000Z'),
        }),
      ),
    ).not.toBeNull();
  });
});
