// ADR-0019.6 — the 2026-10-13 bonus rate change, both sites.
//
// Proves, against the REAL seed CSV and the REAL migration SQL (not a copy of
// their numbers), that:
//   - the new rule pays the approved figures (Bill, 2026-10-07);
//   - each site has exactly one rule covering 2026-10-12 (old) and exactly one
//     covering 2026-10-13 (new), with no overlap anywhere;
//   - period pricing is by each entry's OWN date: a Period 21 entry is priced at
//     old rates whenever it is (re)computed, a synthetic straddling period prices
//     each day by its own rule, and a period with no 10/13+ days is untouched;
//   - deploying before 10/13 changes nothing for any day before 10/13.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateDailyBonusCents, type BonusRuleParams } from '@/lib/bonus/calculator';
import { periodBonusCentsFor } from '@/lib/bonus/paid-units';
import { assemblePdfRows } from '@/lib/bonus/pdf-data';
import {
  NoActiveRuleError,
  OverlappingBonusRulesError,
  ruleForDate,
  ruleLookup,
  type DatedBonusRule,
} from '@/lib/bonus/rule-book';

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Parse prisma/seed/processor_bonus_rules.csv (quoted notes column last). */
function seedBook(site: string): DatedBonusRule[] {
  const csv = readFileSync(join(ROOT, 'prisma/seed/processor_bonus_rules.csv'), 'utf8');
  const [header, ...lines] = csv.trim().split('\n');
  expect(header).toBe(
    'site_code,threshold_low,rate_low,threshold_high,rate_high,effective_date,end_date,notes',
  );
  return lines
    .map((l) => l.split(','))
    .filter((c) => c[0] === site)
    .map((c, i) => ({
      id: `${site}-${i}`,
      threshold_low: Number(c[1]),
      rate_low: c[2]!,
      threshold_high: Number(c[3]),
      rate_high: c[4]!,
      effective_date: c[5]!,
      end_date: c[6] ? c[6] : null,
    }));
}

const NEW_RULE: BonusRuleParams = {
  threshold_low: 60,
  rate_low: '1.0000',
  threshold_high: 100,
  rate_high: '0.2500',
};

describe('new rule payouts (Bill-approved table, whole cents)', () => {
  const table: Array<[number, number]> = [
    [0, 0],
    [50, 0],
    [60, 0],
    [61, 100],
    [65, 500],
    [70, 1000],
    [80, 2000],
    [90, 3000],
    [100, 4000],
    [101, 4125],
    [120, 6500],
    [150, 10250],
  ];
  it.each(table)('%i units → %i cents', (units, cents) => {
    expect(calculateDailyBonusCents(units, NEW_RULE)).toBe(cents);
  });
});

describe.each(['woodland', 'eugene'])('seed rule book — %s', (site) => {
  const book = seedBook(site);

  it('has exactly one rule on 2026-10-12 (old) and one on 2026-10-13 (new)', () => {
    const oct12 = ruleForDate(book, '2026-10-12', { siteId: site });
    const oct13 = ruleForDate(book, '2026-10-13', { siteId: site });
    expect(oct12.effective_date).toBe('2026-01-01');
    expect(oct12.end_date).toBe('2026-10-12');
    expect(oct13).toMatchObject({ ...NEW_RULE, effective_date: '2026-10-13', end_date: null });
  });

  it('covers every day 2026-01-01 → 2027-12-31 exactly once (no gap, no overlap)', () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    while (d.getUTCFullYear() < 2028) {
      expect(() => ruleForDate(book, d, { siteId: site })).not.toThrow();
      d.setUTCDate(d.getUTCDate() + 1);
    }
  });

  it('80 units: old rate on 10/12, $20.00 on 10/13', () => {
    const old = site === 'woodland' ? 1650 : 3000;
    expect(calculateDailyBonusCents(80, ruleForDate(book, '2026-10-12', { siteId: site }))).toBe(
      old,
    );
    expect(calculateDailyBonusCents(80, ruleForDate(book, '2026-10-13', { siteId: site }))).toBe(
      2000,
    );
  });

  it('Period 21 (Sep 29 – Oct 12) prices at OLD rates regardless of when it is recomputed', () => {
    // An amendment made on 2026-10-20 re-locks via the same per-entry-date funnel;
    // nothing in the lookup reads the wall clock, so the result is a pure function
    // of the entry dates.
    const rows = [
      { entry_date: new Date(Date.UTC(2026, 8, 29)), mattress_count: 80, saves: 0 },
      { entry_date: new Date(Date.UTC(2026, 9, 12)), mattress_count: 70, saves: 10 },
    ];
    const perDay = site === 'woodland' ? 1650 : 3000;
    expect(periodBonusCentsFor(rows, ruleLookup(book, { siteId: site }))).toBe(perDay * 2);
  });

  it('a straddling period prices each day by its own date', () => {
    const rows = [
      { entry_date: new Date(Date.UTC(2026, 9, 12)), mattress_count: 80, saves: 0 },
      { entry_date: new Date(Date.UTC(2026, 9, 13)), mattress_count: 80, saves: 0 },
    ];
    const old = site === 'woodland' ? 1650 : 3000;
    expect(periodBonusCentsFor(rows, ruleLookup(book, { siteId: site }))).toBe(old + 2000);
  });

  it('Period 22 (Oct 13 – Oct 26) prices at NEW rates', () => {
    const rows = [55, 65, 101, 150].map((u, i) => ({
      entry_date: new Date(Date.UTC(2026, 9, 13 + i)),
      mattress_count: u,
      saves: 0,
    }));
    expect(periodBonusCentsFor(rows, ruleLookup(book, { siteId: site }))).toBe(
      0 + 500 + 4125 + 10250,
    );
  });
});

describe('ruleForDate guards', () => {
  const a: DatedBonusRule = {
    id: 'a',
    threshold_low: 50,
    rate_low: '1',
    threshold_high: 100,
    rate_high: '0.25',
    effective_date: '2026-01-01',
    end_date: null,
  };

  it('refuses an overlap instead of picking a winner', () => {
    const b = { ...a, id: 'b', effective_date: '2026-10-13' };
    expect(() => ruleForDate([a, b], '2026-10-13', { siteId: 's' })).toThrow(
      OverlappingBonusRulesError,
    );
  });

  it('throws NoActiveRuleError before the first rule, falls back only when asked', () => {
    expect(() => ruleForDate([a], '2025-12-31', { siteId: 's' })).toThrow(NoActiveRuleError);
    expect(ruleForDate([a], '2025-12-31', { siteId: 's', historicalFallback: true }).id).toBe('a');
  });

  it('honours end_date inclusively', () => {
    const closed = { ...a, end_date: '2026-10-12' };
    expect(ruleForDate([closed], '2026-10-12', { siteId: 's' }).id).toBe('a');
    expect(() => ruleForDate([closed], '2026-10-13', { siteId: 's' })).toThrow(NoActiveRuleError);
  });

  it('refuses a missing entry date rather than pricing it', () => {
    expect(() => ruleForDate([a], undefined as unknown as Date, { siteId: 's' })).toThrow(
      TypeError,
    );
  });
});

describe('migration SQL agrees with the seed CSV', () => {
  const sql = readFileSync(
    join(ROOT, 'prisma/migrations/20260867_adr0019_6_bonus_rate_change_20261013/migration.sql'),
    'utf8',
  );
  it('closes the old rule on 2026-10-12 and opens 60/1.00/100/0.25 on 2026-10-13', () => {
    expect(sql).toMatch(/end_date"?\s*=\s*DATE '2026-10-12'/);
    expect(sql).toMatch(/60,\s*1\.0000,\s*100,\s*0\.2500,\s*DATE '2026-10-13'/);
    expect(sql).toContain("'woodland'");
    expect(sql).toContain("'eugene'");
  });
});

describe('Period 22 sample: lock/reconcile funnel and PDF agree', () => {
  it.each(['woodland', 'eugene'])('%s', (site) => {
    const ruleFor = ruleLookup(seedBook(site), { siteId: site });
    const entries = [
      {
        bonus_employee_id: 'a',
        entry_date: new Date(Date.UTC(2026, 9, 13)),
        mattress_count: 80,
        saves: 0,
      },
      {
        bonus_employee_id: 'a',
        entry_date: new Date(Date.UTC(2026, 9, 14)),
        mattress_count: 95,
        saves: 6,
      },
      {
        bonus_employee_id: 'b',
        entry_date: new Date(Date.UTC(2026, 9, 13)),
        mattress_count: 58,
        saves: 0,
      },
    ];
    const locked = periodBonusCentsFor(entries, ruleFor);
    expect(locked).toBe(2000 + 4125 + 0);
    const pdf = assemblePdfRows({
      month: {
        id: 'p22',
        site_id: site,
        period_start: new Date(Date.UTC(2026, 9, 13)),
        period_end: new Date(Date.UTC(2026, 9, 26)),
        state: 'signed',
        total_payout_cents: locked,
        amended_from_period_id: null,
        period_number: 22,
        period_year: 2026,
        pay_date: new Date(Date.UTC(2026, 9, 30)),
      },
      site: { code: site, name: site },
      employees: [
        { id: 'a', full_name: 'A' },
        { id: 'b', full_name: 'B' },
      ],
      entries,
      ruleFor,
    });
    expect(pdf.grandTotalCents).toBe(locked);
  });
});

describe('no pay path prices a period by its start date (static guard)', () => {
  // Before ADR-0019.6 every period read did `resolveActiveRule(site,
  // month.period_start)` and priced the whole period with that one rule. The
  // per-entry-date lookup replaced all of them; this keeps it that way.
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|__tests__/.test(p)) out.push(p);
    }
    return out;
  }
  it('no resolveActiveRule / resolveRuleForHistorical call takes a period start', () => {
    const offenders = walk(join(ROOT, 'src')).filter((f) =>
      /resolve(ActiveRule|RuleForHistorical)\([^)]*period_?[sS]tart/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
