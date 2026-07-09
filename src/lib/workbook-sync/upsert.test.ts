// ADR-0049 D3 — workbook-wins upsert tests: insert, agreement no-op, and the
// overwrite-with-audit of a Vision-captured row (test-plan line 4).

import { describe, expect, it } from 'vitest';
import { upsertDailyProduction } from './upsert';
import { FakePrisma, dec } from './__tests__/fake-prisma';
import type { DailyProductionRow } from './daily-adapter';

const SITE = 'site-woodland';

function row(overrides: Partial<DailyProductionRow> = {}): DailyProductionRow {
  return {
    productionDate: '2026-06-01',
    strippedProgram: 150,
    strippedNonProgram: 25,
    materialTicketNumber: 'M-000401',
    employeesCount: 6,
    processorsCount: 4,
    savedUnits: null,
    ...overrides,
  };
}

describe('upsertDailyProduction (workbook wins, D3)', () => {
  it('inserts a new day with source=import + import_id, and audits the insert', async () => {
    const db = new FakePrisma();
    const res = await upsertDailyProduction({ db: db.asClient(), siteId: SITE, syncRunId: 'run-1', rows: [row()] });
    expect(res).toEqual({ upserted: 1, overwritten: 0 });
    expect(db.pud).toHaveLength(1);
    expect(db.pud[0]).toMatchObject({ source: 'import', import_id: 'run-1' });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: 'insert', table_name: 'processed_units_daily' });
  });

  it('is a no-op when the stored row already agrees', async () => {
    const db = new FakePrisma();
    await upsertDailyProduction({ db: db.asClient(), siteId: SITE, syncRunId: 'run-1', rows: [row()] });
    const before = db.audits.length;
    const res = await upsertDailyProduction({ db: db.asClient(), siteId: SITE, syncRunId: 'run-2', rows: [row()] });
    expect(res).toEqual({ upserted: 0, overwritten: 0 });
    expect(db.audits.length).toBe(before); // no new audit
  });

  it('overwrites a disagreeing VISION-CAPTURED (manual) row and writes an audit entry flagging the overwrite', async () => {
    const db = new FakePrisma();
    // A Vision-captured close that disagrees with the workbook (155 vs 150).
    db.pud.push({
      id: 'pud-existing',
      site_id: SITE,
      production_date: new Date('2026-06-01T00:00:00Z'),
      source: 'manual',
      stripped_program: dec(155),
      stripped_non_program: dec(25),
      material_ticket_number: 'M-000401',
      employees_count: 6,
      processors_count: 4,
      saved_units: null,
      import_id: null,
      closed_at: null,
    });

    const res = await upsertDailyProduction({ db: db.asClient(), siteId: SITE, syncRunId: 'run-9', rows: [row()] });
    expect(res).toEqual({ upserted: 1, overwritten: 1 });
    // The stored row now carries the workbook value + import provenance.
    expect(db.pud[0]).toMatchObject({ source: 'import', import_id: 'run-9' });
    expect(db.pud[0]!.stripped_program.equals(dec(150))).toBe(true);
    // The audit entry records the Vision overwrite.
    const audit = db.audits.at(-1)!;
    expect(audit).toMatchObject({ action: 'update', table_name: 'processed_units_daily' });
    expect((audit.before as { vision_overwrite: boolean }).vision_overwrite).toBe(true);
  });

  it('updates an already-workbook-sourced row that changed WITHOUT counting it as a Vision overwrite', async () => {
    const db = new FakePrisma();
    db.pud.push({
      id: 'pud-wb',
      site_id: SITE,
      production_date: new Date('2026-06-01T00:00:00Z'),
      source: 'import',
      stripped_program: dec(140),
      stripped_non_program: dec(25),
      material_ticket_number: 'M-000401',
      employees_count: 6,
      processors_count: 4,
      saved_units: null,
      import_id: 'run-old',
      closed_at: null,
    });
    const res = await upsertDailyProduction({ db: db.asClient(), siteId: SITE, syncRunId: 'run-10', rows: [row()] });
    expect(res).toEqual({ upserted: 1, overwritten: 0 });
  });
});
