// ADR-0083 — the four-eyes bypass, and the proof that this test would catch it.
//
// THE HAZARD: `shouldRequireAmendment` decides whether a daily-entry write may
// land DIRECTLY or must go through the ADR-0028 four-eyes prior-day amendment
// workflow. It used to compare `mattress_count` alone, because before saves that
// one number WAS the payroll value of the row. Adding a second paid column
// without touching the predicate leaves a hole: a non-admin manager editing a
// PRIOR day and changing ONLY the saves figure computes `countChanged === false`,
// falls into the `note_only_edit` branch, and writes an unapproved change to a
// processor's pay — no approver, no justification, nothing in the review queue.
//
// The `note_only_edit` exemption is sound for what it was written for: a note
// cannot change anybody's pay. Saves can.
//
// A test that merely asserts the CURRENT behaviour would pass beside that bug
// just as happily as it passes with the fix. So the last block below reverts the
// predicate to its pre-ADR-0083 logic and asserts the reverted version routes
// 'direct' — i.e. it demonstrates the RED this file is here to prevent, rather
// than claiming a green proves something.

import { describe, it, expect } from 'vitest';
import { shouldRequireAmendment } from '@/lib/bonus/amendment-requests';
import { appToday } from '@/lib/time';

const TODAY = appToday();
const PRIOR = new Date(TODAY.getTime() - 86_400_000);

const base = {
  periodState: 'draft',
  entryDate: PRIOR,
  actorIsAdmin: false,
} as const;

describe('prior-day saves changes require the four-eyes amendment workflow', () => {
  it('routes a SAVES-ONLY prior-day edit to the amendment workflow', () => {
    const r = shouldRequireAmendment({
      ...base,
      newCount: 76, // unchanged
      existingCount: 76,
      newSaves: 9, // the only thing that moved
      existingSaves: 4,
    });

    expect(r.route).toBe('amendment');
    if (r.route !== 'amendment') throw new Error('unreachable');
    expect(r.changeType).toBe('update');
    // The approver must be shown the value being changed FROM, or the review is
    // theatre.
    expect(r.oldValue).toEqual({ mattress_count: 76, saves: 4, note: null });
  });

  it('routes a prior-day edit that changes BOTH columns to the workflow', () => {
    const r = shouldRequireAmendment({
      ...base,
      newCount: 80,
      existingCount: 76,
      newSaves: 9,
      existingSaves: 4,
    });
    expect(r.route).toBe('amendment');
  });

  it('still routes a genuine note-only prior-day edit DIRECT', () => {
    // The exemption must survive — narrowing a guard to nothing is as bad as
    // leaving the hole. Neither paid column moved, so this stays direct.
    const r = shouldRequireAmendment(
      { ...base, newCount: 76, existingCount: 76, newSaves: 4, existingSaves: 4 },
      'old note',
    );
    expect(r).toEqual({ route: 'direct', reason: 'note_only_edit' });
  });

  it('treats a null existingSaves (pre-column row) as the stored default 0', () => {
    // A row keyed before the column existed stores 0, so proposing 5 IS a
    // change. Reading null as "no change possible" would reopen the bypass for
    // exactly the historical rows most likely to need correcting.
    const r = shouldRequireAmendment({
      ...base,
      newCount: 76,
      existingCount: 76,
      newSaves: 5,
      existingSaves: null,
    });
    expect(r.route).toBe('amendment');
  });

  it('does not fire on a same-day saves change (same-day stays direct)', () => {
    const r = shouldRequireAmendment({
      ...base,
      entryDate: TODAY,
      newCount: 76,
      existingCount: 76,
      newSaves: 9,
      existingSaves: 4,
    });
    expect(r).toEqual({ route: 'direct', reason: 'same_day_or_future' });
  });
});

describe('FALSIFICATION — the pre-ADR-0083 predicate lands the write unapproved', () => {
  /**
   * The shipped predicate's logic with the ADR-0083 line REMOVED — i.e. exactly
   * `amendment-requests.ts` as it stood before this change, reproduced here so
   * the regression can be executed rather than described.
   *
   * "Prose is not a guard": asserting in a comment that the old code was wrong
   * proves nothing. Running it does.
   */
  function shouldRequireAmendment_preAdr0083(input: {
    periodState: string;
    entryDate: Date;
    newCount: number;
    existingCount: number | null;
    actorIsAdmin: boolean;
  }): { route: 'direct' | 'amendment'; reason?: string } {
    if (input.periodState !== 'draft') return { route: 'direct' };
    if (input.actorIsAdmin) return { route: 'direct' };
    if (input.entryDate.getTime() >= appToday().getTime()) return { route: 'direct' };

    const isInsert = input.existingCount === null;
    const countChanged = input.existingCount !== null && input.newCount !== input.existingCount;
    // ← the saves comparison the shipped version now also makes is ABSENT here.
    if (!isInsert && !countChanged) return { route: 'direct', reason: 'note_only_edit' };
    return { route: 'amendment' };
  }

  it('the reverted predicate routes a prior-day saves-only PAY change DIRECT', () => {
    const savesOnlyPriorDayEdit = {
      periodState: 'draft',
      entryDate: PRIOR,
      newCount: 76,
      existingCount: 76,
      actorIsAdmin: false,
    };

    const reverted = shouldRequireAmendment_preAdr0083(savesOnlyPriorDayEdit);

    // This is the defect, executed: a change to what a processor is paid,
    // approved by nobody.
    expect(reverted.route).toBe('direct');
    expect(reverted.reason).toBe('note_only_edit');

    // And the shipped predicate, given the same edit, refuses it.
    const shipped = shouldRequireAmendment({
      ...savesOnlyPriorDayEdit,
      newSaves: 9,
      existingSaves: 4,
    });
    expect(shipped.route).toBe('amendment');
    expect(shipped.route).not.toBe(reverted.route);
  });
});
