// ADR-0124 — the whole dispatch matrix, without React.
//
// Before this change the matrix could only be reached through the DOM: it was
// nested ternaries inside `load-workflow.tsx` reading two `useState` latches, so
// "which stage does a load that already has its BOL photo land on" was not a
// question anything could ask. It is the question the 2026-08-20 incident turned
// on.
//
// The composition suite (`load-workflow.dispatch.test.tsx`) mounts the real
// workflow and asserts the rendered heading agrees with this function on the
// same inputs. Neither file is sufficient alone: this one proves the rule, that
// one proves the rule is the one actually wired up.

import { describe, expect, it } from 'vitest';
import type { LoadStatus } from '@prisma/client';
import { selectStage, WORKING_STATUSES, type StageFacts } from './stage-selection';

function facts(over: Partial<StageFacts> = {}): StageFacts {
  return { status: 'arrived', bolPhotoCount: 0, weightSkipped: false, ...over };
}

describe('the 2026-08-20 re-entry', () => {
  it('a load whose BOL photo is already on the server does NOT return to stage 1', () => {
    // H-137810: `arrived`, one BOL photo, three operators in turn. The old
    // dispatch sent every one of them to `bol`, because `bolDone` is a `useState`
    // and `recordBolCapture` writes nothing at all.
    expect(selectStage(facts({ status: 'arrived', bolPhotoCount: 1 }))).toBe('weight');
  });

  it('a FIRST visit with no BOL photo is still stage 1 — ADR-0060 is intact', () => {
    expect(selectStage(facts({ status: 'arrived', bolPhotoCount: 0 }))).toBe('bol');
  });

  it('a recorded weight skip survives the reload that used to erase it', () => {
    expect(selectStage(facts({ status: 'arrived', bolPhotoCount: 1, weightSkipped: true }))).toBe(
      'door',
    );
  });
});

describe('selectStage — the full matrix', () => {
  const cases: Array<[StageFacts, string | null]> = [
    // `arrived` is the only status that reads more than itself.
    [facts({ bolPhotoCount: 0, weightSkipped: false }), 'bol'],
    [facts({ bolPhotoCount: 0, weightSkipped: true }), 'bol'],
    [facts({ bolPhotoCount: 1, weightSkipped: false }), 'weight'],
    [facts({ bolPhotoCount: 3, weightSkipped: false }), 'weight'],
    [facts({ bolPhotoCount: 1, weightSkipped: true }), 'door'],
    // Past `arrived` the status alone decides.
    [facts({ status: 'weight_captured', bolPhotoCount: 1 }), 'door'],
    [facts({ status: 'unload_started', bolPhotoCount: 1 }), 'decision'],
    [facts({ status: 'in_progress', bolPhotoCount: 1 }), 'stacks'],
    [facts({ status: 'finished', bolPhotoCount: 1 }), 'finish'],
    // Not working statuses — the workflow's closed-load card owns these.
    [facts({ status: 'voided' }), null],
    [facts({ status: 'verified' }), null],
    [facts({ status: 'submitted' }), null],
    [facts({ status: 'rejected' }), null],
    [facts({ status: 'expected' }), null],
  ];

  for (const [f, expected] of cases) {
    it(`${f.status} · bol=${f.bolPhotoCount} · skipped=${f.weightSkipped} → ${expected}`, () => {
      expect(selectStage(f)).toBe(expected);
    });
  }

  it('BOL leads even when a weight skip is recorded', () => {
    // Unreachable in practice — you cannot decide the weight without passing
    // stage 1 — but the ordering is deliberate and worth pinning: ADR-0060's
    // forced BOL is a rule about the load's paperwork, not about the order taps
    // happened in, so a load whose BOL photo is somehow gone goes BACK.
    expect(selectStage(facts({ bolPhotoCount: 0, weightSkipped: true }))).toBe('bol');
  });

  it('every working status yields a stage, and every non-working one yields null', () => {
    // The negative control. Without it, a `selectStage` that returned `null` for
    // everything would pass every positive case above by never being asked.
    const ALL: LoadStatus[] = [
      'expected',
      'arrived',
      'weight_captured',
      'unload_started',
      'in_progress',
      'finished',
      'submitted',
      'rejected',
      'voided',
      'verified',
      'submitted_to_mymrc',
      'processed',
    ];
    for (const status of ALL) {
      const got = selectStage(facts({ status, bolPhotoCount: 1 }));
      if (WORKING_STATUSES.includes(status)) {
        expect(got, `${status} is a working status and must yield a stage`).not.toBeNull();
      } else {
        expect(got, `${status} is not a working status`).toBeNull();
      }
    }
  });
});

describe('the function reads nothing but the facts it is given', () => {
  it('is pure — the same input twice gives the same answer', () => {
    const f = facts({ bolPhotoCount: 1 });
    expect(selectStage(f)).toBe(selectStage(f));
  });

  it('does not mutate its argument', () => {
    const f = facts({ bolPhotoCount: 1 });
    const before = JSON.stringify(f);
    selectStage(f);
    expect(JSON.stringify(f)).toBe(before);
  });
});
