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
import { toConsumedLoad, CONSUMED_SLOT_SELECT } from './consumed-slot';
import { OPEN_DOCK_STATUSES } from './open-loads';

describe('toConsumedLoad — free slot vs worked slot', () => {
  it('a slot with no child is FREE (null), which is what makes a row startable', () => {
    expect(toConsumedLoad(null)).toBeNull();
    expect(toConsumedLoad(undefined)).toBeNull();
  });

  it('THE INCIDENT: a submitted child reports its units and its submission date', () => {
    expect(
      toConsumedLoad({
        status: 'submitted',
        total_units: 159,
        submitted_at: new Date('2026-08-05T23:48:00Z'),
      }),
    ).toEqual({
      status: 'submitted',
      open: false,
      totalUnits: 159,
      workedAt: new Date('2026-08-05T23:48:00Z'),
    });
  });

  it('an open child is `open: true` and carries no submission instant to show', () => {
    const c = toConsumedLoad({ status: 'in_progress', total_units: null, submitted_at: null });
    expect(c?.open).toBe(true);
    expect(c?.workedAt).toBeNull();
  });

  it('`open` tracks OPEN_DOCK_STATUSES exactly — the two cannot drift apart', () => {
    // The mislabel in `held-by-panel.tsx` was a hand-maintained status list that
    // fell behind the enum. This asserts the derivation rather than a copy.
    for (const s of OPEN_DOCK_STATUSES) {
      expect(toConsumedLoad({ status: s, total_units: null, submitted_at: null })?.open).toBe(true);
    }
    for (const s of [
      'submitted',
      'verified',
      'rejected',
      'submitted_to_mymrc',
      'processed',
    ] as const) {
      expect(toConsumedLoad({ status: s, total_units: null, submitted_at: null })?.open).toBe(
        false,
      );
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

  it('the select names the three fields the read-only copy needs', () => {
    // Dropping one of these leaves the surface able to say "already worked" but
    // not "159 units, submitted 5 Aug" — which is the half the dock actually
    // needed, and the half a narrower select would silently remove.
    expect(Object.keys(CONSUMED_SLOT_SELECT).sort()).toEqual([
      'status',
      'submitted_at',
      'total_units',
    ]);
  });
});
