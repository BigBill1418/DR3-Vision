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
    strippedNonProgramInferred: false,
    materialTicketNumber: 'M-000401',
    savedUnits: null,
    ...overrides,
  };
}

describe('upsertDailyProduction (workbook wins, D3)', () => {
  it('inserts a new day with source=import + import_id, and audits the insert', async () => {
    const db = new FakePrisma();
    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row()],
    });
    expect(res).toEqual({ upserted: 1, overwritten: 0, skippedManual: 0 });
    expect(db.pud).toHaveLength(1);
    expect(db.pud[0]).toMatchObject({ source: 'import', import_id: 'run-1' });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: 'insert', table_name: 'processed_units_daily' });
  });

  it('is a no-op when the stored row already agrees', async () => {
    const db = new FakePrisma();
    await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row()],
    });
    const before = db.audits.length;
    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-2',
      rows: [row()],
    });
    expect(res).toEqual({ upserted: 0, overwritten: 0, skippedManual: 0 });
    expect(db.audits.length).toBe(before); // no new audit
  });

  // ADR-0123 — INVERTED. This case previously read "overwrites a disagreeing
  // VISION-CAPTURED (manual) row and writes an audit entry flagging the
  // overwrite", and it passed, because that is what the code did. It is the
  // clearest example in this repo of a test PINNING THE DEFECT AS THE CONTRACT:
  // the behaviour it locked in was the destruction of a human's correction to
  // the number MRC is invoiced on, and the assertion it made about the audit row
  // (`vision_overwrite: true`) was the evidence of the loss being recorded as if
  // it were a feature.
  //
  // Recorded red — this file against `main` at b622494, before the guard:
  //
  //   × leaves a MANUAL row alone and counts the refusal
  //     → expected { upserted: 1, overwritten: 1, … } to deeply equal
  //       { upserted: 0, overwritten: 0, skippedManual: 1 }
  it('leaves a MANUAL row alone and counts the refusal', async () => {
    const db = new FakePrisma();
    // A human correction that disagrees with the workbook (155 vs 150) — the
    // shape of Bill's M-186301 correction, which is 960/110 against a workbook
    // that still says 970/100.
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

    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-9',
      rows: [row()],
    });
    expect(res).toEqual({ upserted: 0, overwritten: 0, skippedManual: 1 });

    // The person's figure and their ownership both stand.
    expect(db.pud[0]).toMatchObject({ source: 'manual', import_id: null });
    expect(db.pud[0]!.stripped_program.equals(dec(155))).toBe(true);
    expect(db.pud[0]!.stripped_non_program.equals(dec(25))).toBe(true);

    // NO audit row. The sync re-reads the same file every ten minutes, so one
    // row per refusal would be ~84 a day per disputed day, in a table that is
    // append-only and must never be cleaned up (hard rule #6). The run ledger's
    // `rows_skipped_manual` is the readable surface.
    expect(db.audits).toHaveLength(0);
  });

  it('the refusal is REPEATABLE — ten minutes later the sync still leaves it alone', async () => {
    // The single most important property, and the one a one-shot assertion
    // misses: this sync is a LOOP. A guard that held once and then let the next
    // tick through would look identical in a single-call test and would destroy
    // the correction within ten minutes on the floor.
    const db = new FakePrisma();
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

    for (let tick = 0; tick < 12; tick++) {
      const res = await upsertDailyProduction({
        db: db.asClient(),
        siteId: SITE,
        syncRunId: `run-tick-${tick}`,
        rows: [row()],
      });
      expect(res.skippedManual, `tick ${tick} did not refuse`).toBe(1);
      expect(res.upserted, `tick ${tick} wrote`).toBe(0);
    }
    expect(db.pud[0]!.stripped_program.equals(dec(155))).toBe(true);
    expect(db.pud[0]).toMatchObject({ source: 'manual' });
    expect(db.audits).toHaveLength(0);
  });

  it('an AGREEING manual row is not counted as a refusal', async () => {
    // `skippedManual` must mean "the workbook wanted to change a human's row and
    // was refused", not "a human owns this row". Conflating them would make the
    // counter fire on every poll for every corrected day forever, and a signal
    // that is always on is not a signal.
    const db = new FakePrisma();
    db.pud.push({
      id: 'pud-agree',
      site_id: SITE,
      production_date: new Date('2026-06-01T00:00:00Z'),
      source: 'manual',
      stripped_program: dec(150),
      stripped_non_program: dec(25),
      material_ticket_number: 'M-000401',
      employees_count: 6,
      processors_count: 4,
      saved_units: null,
      import_id: null,
      closed_at: null,
    });
    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-agree',
      rows: [row()],
    });
    expect(res).toEqual({ upserted: 0, overwritten: 0, skippedManual: 0 });
  });

  it('still overwrites a MYMRC row — the lattice is manual > import > mymrc', async () => {
    // The original D3 rule is unchanged and must stay that way: pre-cutover the
    // workbook outranks the portal. A guard that yielded to `mymrc` too would
    // silently retire workbook-wins, which is a much larger change than the one
    // ADR-0123 makes.
    const db = new FakePrisma();
    db.pud.push({
      id: 'pud-portal',
      site_id: SITE,
      production_date: new Date('2026-06-01T00:00:00Z'),
      source: 'mymrc',
      stripped_program: dec(155),
      stripped_non_program: dec(25),
      material_ticket_number: 'M-000401',
      employees_count: null,
      processors_count: null,
      saved_units: null,
      import_id: null,
      closed_at: null,
    });
    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-portal',
      rows: [row()],
    });
    expect(res).toEqual({ upserted: 1, overwritten: 1, skippedManual: 0 });
    expect(db.pud[0]).toMatchObject({ source: 'import', import_id: 'run-portal' });
    expect(db.pud[0]!.stripped_program.equals(dec(150))).toBe(true);
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
    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-10',
      rows: [row()],
    });
    expect(res).toEqual({ upserted: 1, overwritten: 0, skippedManual: 0 });
  });
});

// ── ADR-0049 Am.3 / D13 — workbook-wins is narrowed per field ────────────────

describe('workbook-wins is narrowed per field (D13)', () => {
  function visionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'pud-vision',
      site_id: SITE,
      production_date: new Date('2026-06-01T00:00:00Z'),
      source: 'mymrc',
      stripped_program: dec(150),
      stripped_non_program: dec(25),
      material_ticket_number: 'M-000401',
      employees_count: 6,
      processors_count: 4,
      saved_units: dec(7),
      import_id: null,
      closed_at: null,
      ...overrides,
    };
  }

  it('NEVER touches employees_count / processors_count — the workbook has no such column', async () => {
    const db = new FakePrisma();
    db.pud.push(visionRow({ stripped_program: dec(999) }) as never);

    await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row({ savedUnits: 7 })],
    });

    // The production figure was overwritten (that is the point of the sync) and
    // the manager's headcount survived it.
    expect(db.pud[0]!.stripped_program.equals(dec(150))).toBe(true);
    expect(db.pud[0]!.employees_count).toBe(6);
    expect(db.pud[0]!.processors_count).toBe(4);
  });

  it('a headcount difference ALONE is not a disagreement — no write, no ownership transfer', async () => {
    // The second-order harm: `disagrees()` used to fire on the headcount alone,
    // which rewrote `source` to 'import' and permanently locked the MyMRC bridge
    // out of the row (it updates only WHERE source = 'mymrc') — an irreversible
    // ownership transfer with no production figure changed.
    const db = new FakePrisma();
    db.pud.push(visionRow() as never);

    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row({ savedUnits: 7 })],
    });

    expect(res).toEqual({ upserted: 0, overwritten: 0, skippedManual: 0 });
    expect(db.pud[0]!.source).toBe('mymrc');
    expect(db.audits).toHaveLength(0);
  });

  it('a null material ticket / saved_units LEAVES the stored value alone', async () => {
    // A mid-edit blank is a routine every-poll event; a deliberately retracted
    // ticket is rare and manually correctable. Getting this backwards means
    // routine blanks chew through real values all day.
    const db = new FakePrisma();
    db.pud.push(visionRow({ stripped_program: dec(999) }) as never);

    await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row({ materialTicketNumber: null, savedUnits: null })],
    });

    expect(db.pud[0]!.stripped_program.equals(dec(150))).toBe(true);
    expect(db.pud[0]!.material_ticket_number).toBe('M-000401');
    expect(db.pud[0]!.saved_units!.equals(dec(7))).toBe(true);
  });

  it('a STATED material ticket still wins', async () => {
    const db = new FakePrisma();
    db.pud.push(visionRow({ material_ticket_number: 'M-OLD' }) as never);

    const res = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row({ materialTicketNumber: 'M-000401', savedUnits: 7 })],
    });

    expect(res.upserted).toBe(1);
    expect(db.pud[0]!.material_ticket_number).toBe('M-000401');
  });

  it('the audit records an INFERRED non-program zero as inferred, not as a stated figure', async () => {
    const db = new FakePrisma();
    await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-1',
      rows: [row({ strippedNonProgram: 0, strippedNonProgramInferred: true })],
    });
    const after = db.audits[0]!.after as Record<string, unknown>;
    expect(after['stripped_non_program']).toBe('0');
    expect(after['stripped_non_program_inferred']).toBe(true);
    // A field the workbook did not state is ABSENT from the trail, not null —
    // a null would read as "we wrote null".
    const noTicket = await upsertDailyProduction({
      db: db.asClient(),
      siteId: SITE,
      syncRunId: 'run-2',
      rows: [row({ productionDate: '2026-06-02', materialTicketNumber: null })],
    });
    expect(noTicket.upserted).toBe(1);
    expect(db.audits.at(-1)!.after as Record<string, unknown>).not.toHaveProperty(
      'material_ticket_number',
    );
  });
});
