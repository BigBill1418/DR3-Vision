// ADR-0125 — the close/reopen refusals, asserted to happen BEFORE any write.
//
// The compare-and-swap half of `closeEodDay`/`reopenEodDay` is a Postgres
// property (a unique index, an `updateMany` count) and is proven against a real
// database in `day-close.db.test.ts`. What is proven HERE is the other half: the
// input rules refuse, and they refuse without touching the database — so a
// rejected close cannot leave a half-written row or a phantom audit entry.
//
// `$transaction` is mocked to THROW. That is the assertion mechanism, not a
// convenience: if a refusal ever moved to after the transaction opened, these
// cases would fail with 'transaction should not have been opened' instead of
// passing quietly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const $transaction = vi.fn(() => {
  throw new Error('transaction should not have been opened');
});
const findUnique = vi.fn();
const findMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) => $transaction(...(a as [])),
    eodDayClose: {
      findUnique: (...a: unknown[]) => findUnique(...(a as [])),
      findMany: (...a: unknown[]) => findMany(...(a as [])),
    },
  },
}));

import { closeEodDay, reopenEodDay, EodCloseError, MIN_EOD_REASON_CHARS } from '../day-close';
import { dayKeyUTCFromISO } from '@/lib/time';

const SITE = 'site-1';
const ACTOR = 'user-1';
const DAY = dayKeyUTCFromISO('2026-08-20');
/** A real instant inside the Pacific day 2026-08-20 (14:00 PDT). */
const NOW = new Date('2026-08-20T21:00:00.000Z');

beforeEach(() => {
  $transaction.mockClear();
  findUnique.mockReset();
  findMany.mockReset();
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof EodCloseError) return e.reason;
    throw e;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('closeEodDay — input refusals', () => {
  it('refuses an exception close with no note, before any write', async () => {
    expect(
      await reason(
        closeEodDay({
          siteId: SITE,
          closeDate: DAY,
          outcome: 'exception',
          actorUserId: ACTOR,
          now: NOW,
        }),
      ),
    ).toBe('note_required');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('refuses an exception close whose note is whitespace — a required reason cannot be a space bar', async () => {
    expect(
      await reason(
        closeEodDay({
          siteId: SITE,
          closeDate: DAY,
          outcome: 'exception',
          exceptionNote: '   ',
          actorUserId: ACTOR,
          now: NOW,
        }),
      ),
    ).toBe('note_required');
    expect($transaction).not.toHaveBeenCalled();
  });

  it(`refuses an exception note shorter than ${MIN_EOD_REASON_CHARS} characters`, async () => {
    expect(
      await reason(
        closeEodDay({
          siteId: SITE,
          closeDate: DAY,
          outcome: 'exception',
          exceptionNote: 'x',
          actorUserId: ACTOR,
          now: NOW,
        }),
      ),
    ).toBe('note_required');
  });

  it('refuses a CLEAN close that carries a note — if there is something to say, it is not clean', async () => {
    // A note on a clean close reads as an unresolved exception to anyone
    // scanning the column, which is the ambiguity the two outcomes remove.
    expect(
      await reason(
        closeEodDay({
          siteId: SITE,
          closeDate: DAY,
          outcome: 'clean',
          exceptionNote: 'terex not entered',
          actorUserId: ACTOR,
          now: NOW,
        }),
      ),
    ).toBe('note_not_allowed');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('refuses a FUTURE day — a pre-closed tomorrow would read "closed" to everyone working it', async () => {
    expect(
      await reason(
        closeEodDay({
          siteId: SITE,
          closeDate: dayKeyUTCFromISO('2026-08-21'),
          outcome: 'clean',
          actorUserId: ACTOR,
          now: NOW,
        }),
      ),
    ).toBe('future_day');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('ACCEPTS a clean close for today and a whitespace-only note (the positive control)', async () => {
    // Without this the suite would pass against a `closeEodDay` that refused
    // everything. It reaches the transaction — which the mock throws from — so
    // "got past validation" is what is being asserted.
    await expect(
      closeEodDay({
        siteId: SITE,
        closeDate: DAY,
        outcome: 'clean',
        exceptionNote: '  ',
        actorUserId: ACTOR,
        now: NOW,
      }),
    ).rejects.toThrow('transaction should not have been opened');
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('ACCEPTS a yesterday close — the manager closes the day after it ends', async () => {
    await expect(
      closeEodDay({
        siteId: SITE,
        closeDate: dayKeyUTCFromISO('2026-08-19'),
        outcome: 'exception',
        exceptionNote: 'terex hours still outstanding',
        actorUserId: ACTOR,
        now: NOW,
      }),
    ).rejects.toThrow('transaction should not have been opened');
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

describe('reopenEodDay — input refusals', () => {
  it('refuses a reopen with no reason, before any write', async () => {
    expect(
      await reason(reopenEodDay({ siteId: SITE, closeDate: DAY, reason: '', actorUserId: ACTOR })),
    ).toBe('reason_required');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('refuses a whitespace reason', async () => {
    expect(
      await reason(
        reopenEodDay({ siteId: SITE, closeDate: DAY, reason: '\t \n', actorUserId: ACTOR }),
      ),
    ).toBe('reason_required');
    expect($transaction).not.toHaveBeenCalled();
  });

  it(`refuses a reason shorter than ${MIN_EOD_REASON_CHARS} characters`, async () => {
    expect(
      await reason(
        reopenEodDay({ siteId: SITE, closeDate: DAY, reason: 'oop', actorUserId: ACTOR }),
      ),
    ).toBe('reason_required');
  });

  it('ACCEPTS a real reason (the positive control)', async () => {
    await expect(
      reopenEodDay({
        siteId: SITE,
        closeDate: DAY,
        reason: 'two hauls landed on the wrong day',
        actorUserId: ACTOR,
      }),
    ).rejects.toThrow('transaction should not have been opened');
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
