// ADR-0071 — processor quota miss/flag logic.
//
// The rule these tests exist to protect: a day with NO recorded production can
// never become a miss. Everything else about this feature is tuning; that one is
// the difference between an alert managers act on and an alert that accuses
// people of being absent on their day off.
//
// Every guard here was falsified before being kept.

import { describe, expect, it } from 'vitest';
import {
  addDaysISO,
  computeProcessorQuotaWeek,
  pacificWeekBounds,
  previousCompleteWeek,
} from './processor-quota';

interface SeedEntry {
  empId: string;
  name: string;
  siteId: string;
  dayISO: string;
  units: number;
  isActive?: boolean;
  deletedAt?: Date | null;
}

/** Minimal fake honouring the ONE where-clause this module builds. */
function fakeDb(entries: SeedEntry[]) {
  return {
    bonusDailyEntry: {
      findMany: async (args: {
        where: {
          bonus_employee: { site_id: string };
          entry_date: { gte: Date; lte: Date };
        };
      }) => {
        const site = args.where.bonus_employee.site_id;
        const gte = args.where.entry_date.gte.getTime();
        const lte = args.where.entry_date.lte.getTime();
        return entries
          .filter((e) => e.siteId === site)
          .filter((e) => {
            const t = new Date(`${e.dayISO}T00:00:00.000Z`).getTime();
            return t >= gte && t <= lte;
          })
          .map((e) => ({
            entry_date: new Date(`${e.dayISO}T00:00:00.000Z`),
            mattress_count: e.units,
            bonus_employee: {
              id: e.empId,
              full_name: e.name,
              is_active: e.isActive ?? true,
              deleted_at: e.deletedAt ?? null,
            },
          }));
      },
    },
  } as never;
}

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const WEEK = '2026-07-20'; // a Monday

const compute = (entries: SeedEntry[], quota = 75, minMisses = 2) =>
  computeProcessorQuotaWeek(fakeDb(entries), {
    siteId: WOODLAND,
    weekStartISO: WEEK,
    quota,
    minMisses,
  });

describe('week bounds', () => {
  it('runs Monday to Sunday', () => {
    // 2026-07-22 is a Wednesday.
    const b = pacificWeekBounds(new Date('2026-07-22T19:00:00.000Z'));
    expect(b.weekStartISO).toBe('2026-07-20');
    expect(b.weekEndISO).toBe('2026-07-26');
  });

  it('treats Sunday as the END of its week, not the start', () => {
    // The off-by-one that would split a week in half and halve everyone's misses.
    const b = pacificWeekBounds(new Date('2026-07-26T19:00:00.000Z')); // Sunday
    expect(b.weekStartISO).toBe('2026-07-20');
    expect(b.weekEndISO).toBe('2026-07-26');
  });

  it('reads the PACIFIC day — a Sunday evening is not yet Monday', () => {
    // 2026-07-27T02:00Z is Sunday 26 July, 7pm PDT. Reading this in UTC lands on
    // Monday the 27th and reports the WRONG WEEK — the one still in progress.
    const b = pacificWeekBounds(new Date('2026-07-27T02:00:00.000Z'));
    expect(b.weekStartISO).toBe('2026-07-20');
  });

  it('previousCompleteWeek steps back a whole week', () => {
    const b = previousCompleteWeek(new Date('2026-07-27T19:00:00.000Z')); // Mon 27th
    expect(b.weekStartISO).toBe('2026-07-20');
    expect(b.weekEndISO).toBe('2026-07-26');
  });

  it('addDaysISO crosses a month boundary', () => {
    expect(addDaysISO('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysISO('2026-08-01', -1)).toBe('2026-07-31');
  });
});

describe('miss + flag logic', () => {
  it('a day with NO recorded production is skipped — never a miss', async () => {
    // Worked Monday and Tuesday, both under quota. Absent the rest of the week.
    // Two misses on two worked days ⇒ flagged; the five absent days contribute
    // nothing. If absence counted, this person would show seven misses.
    const res = await compute([
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 50 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-21', units: 60 },
    ]);
    const row = res.rows[0]!;
    expect(row.days).toHaveLength(2);
    expect(row.misses).toHaveLength(2);
    expect(row.flagged).toBe(true);
  });

  it('exactly the quota is MET, not missed', async () => {
    const res = await compute([
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 75 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-21', units: 75 },
    ]);
    expect(res.rows[0]!.misses).toHaveLength(0);
    expect(res.flagged).toHaveLength(0);
  });

  it('one worked day under quota never flags — two strikes needs two worked days', async () => {
    const res = await compute([
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 10 },
    ]);
    expect(res.rows[0]!.misses).toHaveLength(1);
    expect(res.rows[0]!.flagged).toBe(false);
    expect(res.flagged).toHaveLength(0);
  });

  it('two misses among met days still flags, and records the ACTUAL counts', async () => {
    const res = await compute([
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 62 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-21', units: 100 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-22', units: 64 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-23', units: 75 },
    ]);
    const row = res.rows[0]!;
    expect(row.flagged).toBe(true);
    // The numbers are what let a manager tell a slow slide from two bad days.
    expect(row.misses).toEqual([
      { dayISO: '2026-07-20', units: 62 },
      { dayISO: '2026-07-22', units: 64 },
    ]);
  });

  it('is Woodland-scoped in the QUERY — Eugene can never appear', async () => {
    const res = await compute([
      { empId: 'w1', name: 'Woodland Person', siteId: WOODLAND, dayISO: '2026-07-20', units: 10 },
      { empId: 'w1', name: 'Woodland Person', siteId: WOODLAND, dayISO: '2026-07-21', units: 10 },
      { empId: 'e9', name: 'Eugene Person', siteId: EUGENE, dayISO: '2026-07-20', units: 1 },
      { empId: 'e9', name: 'Eugene Person', siteId: EUGENE, dayISO: '2026-07-21', units: 1 },
    ]);
    expect(res.rows.map((r) => r.name)).toEqual(['Woodland Person']);
    expect(res.flagged.map((r) => r.name)).toEqual(['Woodland Person']);
  });

  it('ignores production outside the week window', async () => {
    const res = await compute([
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-19', units: 1 }, // Sun before
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 1 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-27', units: 1 }, // Mon after
    ]);
    expect(res.rows[0]!.days.map((d) => d.dayISO)).toEqual(['2026-07-20']);
    expect(res.rows[0]!.flagged).toBe(false);
  });

  it('includes BOTH boundary days of the week (Monday and Sunday)', async () => {
    const res = await compute([
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 1 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-26', units: 1 },
    ]);
    expect(res.rows[0]!.days).toHaveLength(2);
    expect(res.rows[0]!.flagged).toBe(true);
  });

  it('a departed employee stays in the report but is never named in the email', async () => {
    // Their production that week was real, so the full-floor report must show it.
    // The email is a list of conversations to have, and you cannot have one with
    // someone who has left.
    const res = await compute([
      {
        empId: 'gone',
        name: 'Departed',
        siteId: WOODLAND,
        dayISO: '2026-07-20',
        units: 10,
        isActive: false,
        deletedAt: new Date('2026-07-23T00:00:00.000Z'),
      },
      {
        empId: 'gone',
        name: 'Departed',
        siteId: WOODLAND,
        dayISO: '2026-07-21',
        units: 10,
        isActive: false,
        deletedAt: new Date('2026-07-23T00:00:00.000Z'),
      },
    ]);
    expect(res.rows[0]!.flagged).toBe(true);
    expect(res.rows[0]!.onRoster).toBe(false);
    expect(res.flagged).toHaveLength(0);
  });

  it('honours a retuned quota and miss threshold without a code change', async () => {
    const entries: SeedEntry[] = [
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-20', units: 50 },
      { empId: 'e1', name: 'A', siteId: WOODLAND, dayISO: '2026-07-21', units: 50 },
    ];
    expect((await compute(entries, 40)).flagged).toHaveLength(0); // quota lowered
    expect((await compute(entries, 75, 3)).flagged).toHaveLength(0); // threshold raised
  });
});
