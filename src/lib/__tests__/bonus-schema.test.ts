import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

// T-100 acceptance: confirm `prisma generate` produced the bonus models with the
// expected shape (columns, enum). This is a type/metadata test — it reads Prisma's
// runtime DMMF rather than hitting the database, so it stays fast and DB-free.

function model(name: string) {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === name);
  expect(m, `model ${name} should exist in the generated client`).toBeTruthy();
  return m!;
}

function fieldNames(name: string): string[] {
  return model(name).fields.map((f) => f.name);
}

describe('Bonus schema — generated Prisma client shape (ADR-0019)', () => {
  it('BonusPayPeriodState enum has the eight lifecycle states', () => {
    const e = Prisma.dmmf.datamodel.enums.find((x) => x.name === 'BonusPayPeriodState');
    expect(e).toBeTruthy();
    // T-310 (ADR-0023) added `historical_imported` for back-imported spreadsheet
    // periods — the eighth state alongside the original seven.
    expect(e!.values.map((v) => v.name).sort()).toEqual(
      [
        'amended',
        'draft',
        'historical_imported',
        'paid',
        'partially_signed',
        'pending_signatures',
        'signed',
        'skipped',
      ].sort(),
    );
  });

  it('BonusEmployee has identity, soft-delete, and previous_names columns', () => {
    const f = fieldNames('BonusEmployee');
    expect(f).toEqual(
      expect.arrayContaining([
        'id',
        'site_id',
        'full_name',
        'previous_names',
        'is_active',
        'user_id',
        'deleted_at',
        'daily_entries',
      ]),
    );
  });

  it('BonusDailyEntry captures the keying user and a unique (employee, date)', () => {
    const m = model('BonusDailyEntry');
    const f = m.fields.map((x) => x.name);
    expect(f).toEqual(
      expect.arrayContaining([
        'bonus_employee_id',
        'bonus_pay_period_id',
        'entry_date',
        'mattress_count',
        'note',
        'entered_by_user_id',
      ]),
    );
    // Unique constraint on (bonus_employee_id, entry_date) per ADR-0019.
    const uniques = m.uniqueIndexes.map((u) => u.fields.join(','));
    expect(uniques).toContain('bonus_employee_id,entry_date');
  });

  it('BonusPayPeriod carries dual-signature, override, PDF, payroll, and amendment columns', () => {
    const f = fieldNames('BonusPayPeriod');
    expect(f).toEqual(
      expect.arrayContaining([
        'state',
        'period_start',
        'period_end',
        'facility_signed_by_user_id',
        'facility_signed_ip',
        'facility_override_actor_id',
        'facility_override_reason',
        'ops_signed_by_user_id',
        'ops_override_actor_id',
        'pdf_storage_key',
        'payroll_sent_at',
        'payroll_message_id',
        'payroll_retry_count',
        'amended_from_period_id',
        'amendment_reason',
        'total_payout_cents',
      ]),
    );
  });

  it('BonusPayPeriod is unique per (site, period_start)', () => {
    const m = model('BonusPayPeriod');
    const uniques = m.uniqueIndexes.map((u) => u.fields.join(','));
    expect(uniques).toContain('site_id,period_start');
  });
});
