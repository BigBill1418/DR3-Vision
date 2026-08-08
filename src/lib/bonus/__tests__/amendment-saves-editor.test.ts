// ADR-0083 Amendment 1 — the amended-month editor can set `saves`, and the
// "absent means UNCHANGED" contract that makes that safe.
//
// ## What was missing
//
// `AmendmentPanel` (the ONLY editor that reaches an already-signed period, via
// an admin unlock) shipped with four columns while ADR-0083 added a fifth paid
// quantity. So a mis-keyed saves figure inside a signed period had no correction
// surface anywhere in the app. Nothing was ever lost by that gap — the service
// treats an absent `saves` as UNCHANGED — but the gap had a deadline: the first
// signed period containing a non-zero save closes at the end of the current
// bi-weekly period.
//
// ## Why the fake here models `saves` and the sibling `amendment.test.ts` does not
//
// That file's `DailyEntry` fixture has no `saves` column at all, so its upsert
// physically cannot tell "left unchanged" from "written as 0" — both look
// identical in a store that never held the value. A test for the unchanged
// contract written against it would be measuring the fake.
//
// The store below carries `saves` as a real column and the upsert merges with
// `Object.assign(existing, update)` — the same generic merge Prisma performs,
// with NO knowledge of which columns exist. So whether saves survives a
// note-only correction is decided by whether `upsertAmendedMonthEntries` OMITS
// the key from its `update` object, which is exactly the claim under test. The
// falsification block at the bottom re-runs the identical input through the
// `saves: input.saves ?? 0` shape and shows the pay cut land.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldRequireAmendment } from '@/lib/bonus/amendment-requests';
import { appToday } from '@/lib/time';
import {
  upsertAmendedMonthEntries,
  type AmendmentEntryDb,
  type AmendmentEntryInput,
} from '@/lib/bonus/amendment';
import { dailyBonusCentsFor, periodBonusCentsFor } from '@/lib/bonus/paid-units';

const WOODLAND = 'site-woodland';
const MONTH = 'm-may';
const MARIA = 'emp-maria';
const AAMIR = 'emp-aamir';
const ADMIN = 'user-bill';
const DAY = new Date(Date.UTC(2026, 4, 12));

/** The live Woodland rule shape: tiered, not flat. */
const RULE = { threshold_low: 50, rate_low: 0.5, threshold_high: 75, rate_high: 0.25 };

interface EntryRow {
  id: string;
  bonus_employee_id: string;
  bonus_pay_period_id: string;
  entry_date: Date;
  mattress_count: number;
  saves: number;
  note: string | null;
  entered_by_user_id: string;
}

let entries: EntryRow[] = [];
let audit: Array<{ action: string; before: unknown; after: unknown }> = [];
let seq = 0;

function makeDb(state = 'amended'): AmendmentEntryDb {
  const db: AmendmentEntryDb = {
    bonusPayPeriod: {
      findFirst: async ({ where }) =>
        where.id === MONTH && where.site_id === WOODLAND
          ? { id: MONTH, site_id: WOODLAND, state: state as never }
          : null,
    },
    bonusEmployee: {
      // Site-scoped, like the real query: an employee id that is not this
      // site's simply does not come back, which is what makes
      // `employee_not_in_site` reachable rather than mocked away.
      findMany: async ({ where }) =>
        where.site_id === WOODLAND
          ? where.id.in.filter((i) => i === MARIA || i === AAMIR).map((id) => ({ id }))
          : [],
    },
    bonusDailyEntry: {
      findUnique: async ({ where }) => {
        const k = where.bonus_employee_id_entry_date;
        const e = entries.find(
          (r) =>
            r.bonus_employee_id === k.bonus_employee_id &&
            r.entry_date.getTime() === k.entry_date.getTime(),
        );
        return e ? { ...e } : null;
      },
      upsert: async ({ where, create, update }) => {
        const k = where.bonus_employee_id_entry_date;
        const existing = entries.find(
          (r) =>
            r.bonus_employee_id === k.bonus_employee_id &&
            r.entry_date.getTime() === k.entry_date.getTime(),
        );
        if (existing) {
          // A GENERIC merge — no knowledge of `saves`. A key the service omits
          // simply is not in `update`, so the stored value stands. This is what
          // makes the unchanged assertion below real rather than circular.
          Object.assign(existing, update);
          return { ...existing };
        }
        const row: EntryRow = {
          id: `de-${++seq}`,
          bonus_employee_id: create['bonus_employee_id'] as string,
          bonus_pay_period_id: create['bonus_pay_period_id'] as string,
          entry_date: create['entry_date'] as Date,
          mattress_count: create['mattress_count'] as number,
          saves: create['saves'] as number,
          note: (create['note'] as string | null) ?? null,
          entered_by_user_id: create['entered_by_user_id'] as string,
        };
        entries.push(row);
        return { ...row };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        audit.push({
          action: data['action'] as string,
          before: data['before'],
          after: data['after'],
        });
        return null;
      },
    },
    $transaction: async (fn) => fn(db),
  };
  return db;
}

const seedEntry = (over: Partial<EntryRow> & { bonus_employee_id: string }): EntryRow => {
  const row: EntryRow = {
    id: `de-seed-${++seq}`,
    bonus_pay_period_id: MONTH,
    entry_date: DAY,
    mattress_count: 0,
    saves: 0,
    note: null,
    entered_by_user_id: 'user-janette',
    ...over,
  };
  entries.push(row);
  return row;
};

const save = (inputs: AmendmentEntryInput[], state = 'amended') =>
  upsertAmendedMonthEntries(makeDb(state), MONTH, WOODLAND, DAY, inputs, { userId: ADMIN });

const rowFor = (id: string) => entries.find((e) => e.bonus_employee_id === id)!;

beforeEach(() => {
  entries = [];
  audit = [];
  seq = 0;
});

// ─────────────────────────────────────────────────────────────────────────

describe('the amended-month editor writes saves', () => {
  it('corrects a mis-keyed saves figure inside an unlocked (signed→amended) period', async () => {
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 76, saves: 40 }); // 40 was a typo

    const result = await save([{ bonus_employee_id: MARIA, mattress_count: 76, saves: 4 }]);

    expect(result.ok).toBe(true);
    expect(rowFor(MARIA).saves).toBe(4);
    // ...and the correction is auditable in both directions (hard rule #6).
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({ mattress_count: 76, saves: 40 });
    expect(audit[0]?.after).toMatchObject({ mattress_count: 76, saves: 4 });
  });

  it('accepts a SAVES-ONLY row — a resale shift with a zero processed count is a paid day', async () => {
    const result = await save([{ bonus_employee_id: AAMIR, mattress_count: 0, saves: 62 }]);
    expect(result.ok).toBe(true);
    expect(rowFor(AAMIR)).toMatchObject({ mattress_count: 0, saves: 62 });
    // 62 paid units clears the 50-unit threshold: (62−50) × $0.50 = $6.00.
    expect(dailyBonusCentsFor(rowFor(AAMIR), RULE)).toBe(600);
  });

  it('rejects an out-of-range saves rather than clamping it', async () => {
    const bad = await save([{ bonus_employee_id: MARIA, mattress_count: 10, saves: 1000 }]);
    expect(bad).toEqual({ ok: false, reason: 'saves_out_of_range' });
    // Refused, not partially applied.
    expect(entries).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('refuses entirely once the month is locked again — this is not a back door', async () => {
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 76, saves: 4 });
    const locked = await save(
      [{ bonus_employee_id: MARIA, mattress_count: 76, saves: 9 }],
      'signed',
    );
    expect(locked).toMatchObject({ ok: false, reason: 'month_locked', state: 'signed' });
    expect(rowFor(MARIA).saves).toBe(4);
    expect(audit).toHaveLength(0);
  });
});

describe('an ABSENT saves means UNCHANGED, never zero', () => {
  it('a note-only correction from a stale tab leaves the day’s saves alone', async () => {
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 76, saves: 9 });

    // A client too old to know about the column: no `saves` key at all.
    await save([{ bonus_employee_id: MARIA, mattress_count: 76, note: 'recount confirmed' }]);

    expect(rowFor(MARIA).saves).toBe(9);
    expect(rowFor(MARIA).note).toBe('recount confirmed');
  });

  it('an explicit 0 still CLEARS the value — unchanged must not become unclearable', async () => {
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 76, saves: 9 });
    await save([{ bonus_employee_id: MARIA, mattress_count: 76, saves: 0 }]);
    expect(rowFor(MARIA).saves).toBe(0);
  });

  it('a NEW row with no saves is created at 0, because there is nothing to preserve', async () => {
    await save([{ bonus_employee_id: AAMIR, mattress_count: 55 }]);
    expect(rowFor(AAMIR).saves).toBe(0);
  });
});

describe('the month total recomputes over the amended saves', () => {
  it('a saves correction moves the period total by the tiered amount', async () => {
    // Two processors, both keyed low enough that saves are what cross the tier.
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 45, saves: 0 });
    seedEntry({ bonus_employee_id: AAMIR, mattress_count: 48, saves: 0 });

    // Both sit UNDER the 50-unit threshold, so the month pays nothing yet.
    expect(periodBonusCentsFor(entries, RULE)).toBe(0);

    await save([
      { bonus_employee_id: MARIA, mattress_count: 45, saves: 20 }, // 65 paid units
      { bonus_employee_id: AAMIR, mattress_count: 48, saves: 30 }, // 78 paid units
    ]);

    // Maria: (65−50)×50¢ = 750¢. Aamir: (78−50)×50¢ + (78−75)×25¢ = 1400 + 75 = 1475¢.
    expect(dailyBonusCentsFor(rowFor(MARIA), RULE)).toBe(750);
    expect(dailyBonusCentsFor(rowFor(AAMIR), RULE)).toBe(1475);
    expect(periodBonusCentsFor(entries, RULE)).toBe(2225);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FALSIFICATIONS — each runs the WRONG implementation beside the shipped one
// on the same input, so the red is an executed fact rather than a paragraph.
// ─────────────────────────────────────────────────────────────────────────

describe('FALSIFICATION — "absent means 0" is a silent pay cut', () => {
  it('a note-only edit zeroes a real saves figure and under-pays the day', async () => {
    const shipped = { mattress_count: 76, saves: 9 };

    // The shipped `update` object for a note-only input: the key is OMITTED.
    const shippedUpdate = (input: AmendmentEntryInput) => ({
      mattress_count: input.mattress_count,
      ...(input.saves === undefined ? {} : { saves: input.saves }),
      note: input.note ?? null,
    });
    // The one-character mistake this pins: a nullish default instead of an omit.
    const brokenUpdate = (input: AmendmentEntryInput) => ({
      mattress_count: input.mattress_count,
      saves: input.saves ?? 0,
      note: input.note ?? null,
    });

    const noteOnly: AmendmentEntryInput = {
      bonus_employee_id: MARIA,
      mattress_count: 76,
      note: 'recount confirmed',
    };

    const afterShipped = { ...shipped, ...shippedUpdate(noteOnly) };
    const afterBroken = { ...shipped, ...brokenUpdate(noteOnly) };

    // The defect, executed. Note nothing threw and nothing was validated away —
    // 9 saved mattresses simply stopped existing on an edit that touched a note.
    expect(afterBroken.saves).toBe(0);
    expect(afterShipped.saves).toBe(9);

    // And what it costs. 76 processed alone: (76−50)×50¢ + (76−75)×25¢ = 1325¢.
    // 76 + 9 = 85 paid units: (85−50)×50¢ + (85−75)×25¢ = 1750 + 250 = 2000¢.
    const paidBroken = dailyBonusCentsFor(afterBroken, RULE);
    const paidShipped = dailyBonusCentsFor(afterShipped, RULE);
    expect(paidBroken).toBe(1325);
    expect(paidShipped).toBe(2000);
    expect(paidShipped - paidBroken).toBe(675); // $6.75 under-paid, on one day, silently.

    // Proof the SHIPPED service really omits the key (not merely that this
    // file's arithmetic is self-consistent): run it and watch the store hold.
    entries = [];
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 76, saves: 9 });
    await save([noteOnly]);
    expect(rowFor(MARIA).saves).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FOUR-EYES — pinned from this surface, and the premise that turned out wrong
//
// The brief for this change said the amended-month editor is "the same
// `shouldRequireAmendment` path" and asked for four-eyes routing to be pinned
// from it. Checked against the code, that is NOT so, and the tests below record
// what the control on this surface actually is rather than asserting the brief:
//
//   • `shouldRequireAmendment` is reached only from `upsertDailyEntries`
//     (daily-entry.ts), the PRIMARY grid's path. `upsertAmendedMonthEntries`
//     does not import it and never has.
//   • That is by design, not an oversight. This surface is reachable only after
//     an ADMIN has explicitly unlocked a signed month with a written reason,
//     which CLEARS BOTH SIGNATURES; the corrected month must then be re-submitted
//     and re-signed by two signers before it pays. The four eyes are the two
//     re-signatures, applied to the whole corrected month, rather than a
//     per-edit approval request. Routing edits here into the request queue as
//     well would file an approval for a change nobody can act on until the
//     re-signing happens anyway.
//   • What must NOT be true is that this path becomes a way to move a signed
//     month's numbers WITHOUT that unlock. That is pinned behaviourally by
//     `refuses entirely once the month is locked again` above, and structurally
//     by the import assertion below.
// ─────────────────────────────────────────────────────────────────────────

describe('the four-eyes control on the amended-month editor', () => {
  it('the amendment service does not route through shouldRequireAmendment, and says why', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../amendment.ts'),
      'utf8',
    );
    // If somebody wires the request workflow in here, this fails and they have
    // to come read the block above and decide deliberately.
    expect(src).not.toContain('shouldRequireAmendment');
  });

  it('the PRIMARY grid still routes a prior-day SAVES-ONLY edit to the workflow', () => {
    // The control that DOES use the predicate, re-pinned from the saves angle so
    // widening this editor cannot quietly become an argument for relaxing that
    // one. (`four-eyes-saves.test.ts` carries the falsification.)
    const r = shouldRequireAmendment({
      periodState: 'draft',
      entryDate: new Date(appToday().getTime() - 86_400_000),
      actorIsAdmin: false,
      newCount: 76,
      existingCount: 76,
      newSaves: 9,
      existingSaves: 4,
    });
    expect(r.route).toBe('amendment');
  });
});

describe('FALSIFICATION — tiering the two columns SEPARATELY pays nothing', () => {
  it('a 45 + 20 day pays $7.50 summed and $0.00 tiered twice', async () => {
    seedEntry({ bonus_employee_id: MARIA, mattress_count: 45, saves: 0 });
    await save([{ bonus_employee_id: MARIA, mattress_count: 45, saves: 20 }]);
    const row = rowFor(MARIA);

    // The shipped model: ONE tier application over 65 paid units.
    expect(dailyBonusCentsFor(row, RULE)).toBe(750);

    // The plausible-looking wrong model, executed: bonus(count) + bonus(saves).
    // Each column sits under the 50-unit threshold, so it pays ZERO — which is
    // what "we added a saves column and nobody was ever paid for a save" looks
    // like in code.
    const separately =
      dailyBonusCentsFor({ mattress_count: row.mattress_count, saves: 0 }, RULE) +
      dailyBonusCentsFor({ mattress_count: 0, saves: row.saves }, RULE);
    expect(separately).toBe(0);
  });
});
