// T-112 — PDF data-assembly unit tests (ADR-0019 §10).
//
// DB-free: `assemblePdfRows` is pure — it takes the already-fetched month,
// employees, daily entries, and the Woodland rule, and returns the per-employee
// rows + totals that drive the printed PDF. We assert the grand total equals
// `calculateMonthlyBonusCents` over the same per-day counts so the PDF number can
// never diverge from the single calculator (CLAUDE.md hard rule #3).

import { describe, it, expect } from 'vitest';
import {
  assemblePdfRows,
  buildAttestation,
  formatPeriodTitle,
  bareSiteName,
  type AttestationSlotInput,
  type PdfMonthInput,
} from './pdf-data';
import {
  calculateMonthlyBonusCents,
  calculateDailyBonusCents,
  type BonusRuleParams,
} from './calculator';

// Woodland rule (ADR-0019 §1): 51–74 each $0.50, 75+ each $0.75.
const WOODLAND: BonusRuleParams = {
  threshold_low: 50,
  rate_low: '0.5000',
  threshold_high: 74,
  rate_high: '0.2500',
};

function dayUTC(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function baseInput(): PdfMonthInput {
  return {
    month: {
      id: 'bm-1',
      site_id: 'site-wood',
      period_start: dayUTC(2026, 4, 1), // 2026-05-01
      period_end: dayUTC(2026, 4, 31),
      state: 'signed',
      total_payout_cents: null,
      amended_from_period_id: null,
      period_number: 10,
      period_year: 2026,
      pay_date: dayUTC(2026, 4, 5),
    },
    site: { code: 'woodland', name: 'Woodland' },
    employees: [
      { id: 'e1', full_name: 'Ana Reyes' },
      { id: 'e2', full_name: 'Beto Cruz' },
    ],
    entries: [
      // Ana: two qualifying days + one sub-threshold day (no bonus).
      { bonus_employee_id: 'e1', entry_date: dayUTC(2026, 4, 1), mattress_count: 60, saves: 0 },
      { bonus_employee_id: 'e1', entry_date: dayUTC(2026, 4, 2), mattress_count: 80, saves: 0 },
      { bonus_employee_id: 'e1', entry_date: dayUTC(2026, 4, 3), mattress_count: 40, saves: 0 },
      // Beto: one qualifying day.
      { bonus_employee_id: 'e2', entry_date: dayUTC(2026, 4, 1), mattress_count: 74, saves: 0 },
    ],
    rule: WOODLAND,
  };
}

describe('assemblePdfRows', () => {
  it('computes per-employee days-qualified, mattresses, and bonus cents', () => {
    const out = assemblePdfRows(baseInput());

    const ana = out.rows.find((r) => r.employeeId === 'e1')!;
    const beto = out.rows.find((r) => r.employeeId === 'e2')!;

    // Days qualified = days with a positive bonus (the 40-count day does not count).
    expect(ana.daysQualified).toBe(2);
    expect(ana.totalMattresses).toBe(60 + 80 + 40);
    expect(ana.totalBonusCents).toBe(
      calculateDailyBonusCents(60, WOODLAND) +
        calculateDailyBonusCents(80, WOODLAND) +
        calculateDailyBonusCents(40, WOODLAND),
    );

    expect(beto.daysQualified).toBe(1);
    expect(beto.totalMattresses).toBe(74);
    expect(beto.totalBonusCents).toBe(calculateDailyBonusCents(74, WOODLAND));
  });

  it('grand total equals calculateMonthlyBonusCents over all per-day counts', () => {
    const input = baseInput();
    const out = assemblePdfRows(input);

    const allCounts = input.entries.map((e) => e.mattress_count);
    expect(out.grandTotalCents).toBe(calculateMonthlyBonusCents(allCounts, WOODLAND));
    // And it equals the sum of the per-employee totals.
    expect(out.grandTotalCents).toBe(out.rows.reduce((s, r) => s + r.totalBonusCents, 0));
  });

  it('includes employees with entries even if zero-bonus, sorted by name', () => {
    const out = assemblePdfRows(baseInput());
    expect(out.rows.map((r) => r.name)).toEqual(['Ana Reyes', 'Beto Cruz']);
  });

  it('omits employees with no entries this month', () => {
    const input = baseInput();
    input.employees.push({ id: 'e3', full_name: 'Carlos Nieto' });
    const out = assemblePdfRows(input);
    expect(out.rows.find((r) => r.employeeId === 'e3')).toBeUndefined();
  });

  it('builds a document id of the form bonus-<site>-<YYYY-MM>-<short>', () => {
    const out = assemblePdfRows(baseInput());
    expect(out.documentId).toMatch(/^bonus-woodland-2026-05-[0-9a-f]{8}$/);
    expect(out.monthLabel).toBe('May 2026');
  });

  it('flags amended months', () => {
    const input = baseInput();
    input.month.amended_from_period_id = 'bm-prior';
    const out = assemblePdfRows(input);
    expect(out.isAmended).toBe(true);
  });

  it('falls back to total_payout_cents when present for the grand total cross-check', () => {
    // total_payout_cents is the locked-at-sign-time figure; assembly still
    // computes from entries but exposes the locked value for reconciliation.
    const input = baseInput();
    input.month.total_payout_cents = 4242;
    const out = assemblePdfRows(input);
    expect(out.lockedTotalCents).toBe(4242);
  });
});

// T-209 — bi-weekly title + slot-source attestation (ADR-0019.1 §1, §4).

describe('bareSiteName', () => {
  it('strips the seeded "DR3 " prefix so the title does not double it', () => {
    expect(bareSiteName('DR3 Woodland')).toBe('Woodland');
    expect(bareSiteName('DR3 Eugene')).toBe('Eugene');
  });
  it('is a no-op for a name without the prefix', () => {
    expect(bareSiteName('Woodland')).toBe('Woodland');
  });
});

describe('formatPeriodTitle', () => {
  // Period 13 of 2026: Tue Jun 9 → Mon Jun 22, pay date Fri Jun 26.
  const p13 = {
    periodNumber: 13,
    periodYear: 2026,
    periodStart: dayUTC(2026, 5, 9),
    periodEnd: dayUTC(2026, 5, 22),
    payDate: dayUTC(2026, 5, 26),
  };

  it('renders the Woodland title in the ADR-0019.1 format', () => {
    const out = formatPeriodTitle({ siteName: 'DR3 Woodland', ...p13 });
    expect(out.title).toBe('DR3 Woodland Bonus Report — Period 13: Jun 9 – Jun 22, 2026');
    expect(out.payDateLine).toBe('Pay date: Jun 26, 2026');
  });

  it('renders the Eugene title from site name with no hardcoding', () => {
    const out = formatPeriodTitle({ siteName: 'DR3 Eugene', ...p13 });
    expect(out.title).toBe('DR3 Eugene Bonus Report — Period 13: Jun 9 – Jun 22, 2026');
  });

  it('does not double the DR3 prefix', () => {
    const out = formatPeriodTitle({ siteName: 'DR3 Woodland', ...p13 });
    expect(out.title.startsWith('DR3 DR3')).toBe(false);
  });
});

describe('buildAttestation', () => {
  const STD = 'I attest that the counts are accurate.';
  const base: AttestationSlotInput = {
    slotRole: 'Facility Manager',
    primarySignerName: null,
    overrideActorName: null,
    overrideReason: null,
    autoOverrideAt: null,
    autoOverrideActorName: null,
    naturalSignerName: 'Janette Tomas',
  };

  it('primary-signed renders the standard attestation', () => {
    const out = buildAttestation({ ...base, primarySignerName: 'Janette Tomas' }, STD);
    expect(out.source).toBe('primary');
    expect(out.lines).toEqual([STD]);
  });

  it('manual override renders human-override language with the reason', () => {
    const out = buildAttestation(
      {
        ...base,
        overrideActorName: 'Bill Barnard',
        overrideReason: 'Janette on medical leave',
      },
      STD,
    );
    expect(out.source).toBe('manual_override');
    expect(out.lines[0]).toBe(
      'Signed by Bill Barnard, Administrator, on behalf of Janette Tomas, Facility Manager.',
    );
    expect(out.lines[1]).toBe('Reason: Janette on medical leave');
  });

  it('auto override renders the ADR-0019.1 escalation language', () => {
    // Tue Jun 9 2026 08:30 PT == 15:30 UTC (PDT, UTC-7).
    const at = new Date('2026-06-09T15:30:00Z');
    const out = buildAttestation(
      {
        ...base,
        overrideActorName: 'Bill Barnard',
        autoOverrideAt: at,
        autoOverrideActorName: 'Bill Barnard',
      },
      STD,
    );
    expect(out.source).toBe('auto_override');
    expect(out.lines[0]).toBe(
      'Signed by Bill Barnard, Administrator, on behalf of Janette Tomas, Facility Manager.',
    );
    expect(out.lines[1]).toBe(
      'System-applied admin override per ADR-0019.1 escalation policy. Janette Tomas did not sign by 08:30 AM PT on Tue Jun 9, 2026.',
    );
  });

  it('auto override wins over a manual override actor when autoOverrideAt is set', () => {
    const at = new Date('2026-06-09T15:30:00Z');
    const out = buildAttestation(
      {
        ...base,
        overrideActorName: 'Someone Else',
        autoOverrideAt: at,
        autoOverrideActorName: 'Bill Barnard',
      },
      STD,
    );
    expect(out.source).toBe('auto_override');
    expect(out.lines[0]).toContain('Signed by Bill Barnard');
  });

  it('unsigned slot falls back to the standard attestation', () => {
    const out = buildAttestation(base, STD);
    expect(out.source).toBe('unsigned');
    expect(out.lines).toEqual([STD]);
  });
});
