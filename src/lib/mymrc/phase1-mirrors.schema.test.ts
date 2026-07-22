import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Schema-foundation parity guard for ADR-0057 Phase 1 — the mirrors adapted to
// the REAL Phase-0 object catalog (docs/mymrc-discovery-2026-07-22.md) plus the
// new dock-availability mirror and backfill-cursor table. Text-based, DB-free —
// mirrors the reconciliation-queue / credential-store parity suites. Locks the
// hand-authored 20260804 migration to the Prisma models so a later edit to one
// without the other fails CI.
const root = process.cwd();
const migrationSql = readFileSync(
  resolve(root, 'prisma/migrations/20260804_adr0057_phase1_real_mirrors/migration.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');

describe('ADR-0057 Phase 1 — Haul_Request__c mirror', () => {
  const HAUL_NEW_COLS = [
    'type',
    'recycler_name',
    'recycler_account_id',
    'transporter_name',
    'collection_site',
    'collection_source',
    'commodity',
    'container_type',
    'program_unit_count',
    'non_program_unit_count',
    'unpaid_consumer_dropoff_units',
    'docking_appointment_date',
  ];

  it('migration widens site_id to nullable (detail-derived site)', () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE "mymrc_hauls_mirror"[\s\S]*?ALTER COLUMN "site_id" DROP NOT NULL/,
    );
  });

  it('migration adds every real billing / discriminator column', () => {
    for (const col of HAUL_NEW_COLS) {
      expect(migrationSql).toContain(`ADD COLUMN "${col}"`);
    }
  });

  it('schema.prisma declares the added columns + nullable site_id', () => {
    const block = schema.slice(
      schema.indexOf('model MymrcHaulsMirror'),
      schema.indexOf('@@map("mymrc_hauls_mirror")'),
    );
    expect(block).toMatch(/site_id\s+String\?/); // nullable
    for (const col of HAUL_NEW_COLS) {
      expect(block).toContain(col);
    }
  });
});

describe('ADR-0057 Phase 1 — Materials__c (processed + outbound) mirrors', () => {
  const MATERIALS_NEW_COLS = [
    'type',
    'account_name',
    'account_id',
    'materials_status',
    'program_unit_count',
    'non_program_unit_count',
  ];

  for (const [table, model] of [
    ['mymrc_processed_mirror', 'MymrcProcessedMirror'],
    ['mymrc_outbound_mirror', 'MymrcOutboundMirror'],
  ] as const) {
    it(`${table}: migration widens site_id + adds Type__c-split columns`, () => {
      expect(migrationSql).toMatch(
        new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?ALTER COLUMN "site_id" DROP NOT NULL`),
      );
      for (const col of MATERIALS_NEW_COLS) {
        expect(migrationSql).toContain(`ADD COLUMN "${col}"`);
      }
    });

    it(`${table}: schema.prisma declares nullable site_id + columns`, () => {
      const block = schema.slice(
        schema.indexOf(`model ${model}`),
        schema.indexOf(`@@map("${table}")`),
      );
      expect(block).toMatch(/site_id\s+String\?/);
      for (const col of MATERIALS_NEW_COLS) {
        expect(block).toContain(col);
      }
    });
  }
});

describe('ADR-0057 Phase 1 — Dock_Availability_Schedule__c mirror (NEW)', () => {
  const DOCK_COLS = [
    'external_schedule_id',
    'status',
    'day_of_week',
    'container_type',
    'dock_door',
    'slot_start_time',
    'slot_end_time',
    'available_appointments',
    'availability_start_date',
    'payload',
  ];

  it('migration creates the mapped table with every field + lifecycle', () => {
    expect(migrationSql).toContain('CREATE TABLE "mymrc_dock_availability_mirror"');
    for (const col of DOCK_COLS) {
      expect(migrationSql).toContain(`"${col}"`);
    }
    for (const life of ['first_seen_at', 'last_seen_at', 'disappeared_at', 'detail_fetched_at']) {
      expect(migrationSql).toContain(`"${life}"`);
    }
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "mymrc_dock_availability_mirror_external_schedule_id_key"',
    );
  });

  it('slot times are TEXT (Salesforce Time, never a datetime)', () => {
    expect(migrationSql).toMatch(/"slot_start_time" TEXT/);
    expect(migrationSql).toMatch(/"slot_end_time" TEXT/);
    const block = schema.slice(
      schema.indexOf('model MymrcDockAvailabilityMirror'),
      schema.indexOf('@@map("mymrc_dock_availability_mirror")'),
    );
    expect(block).toMatch(/slot_start_time\s+String\?/);
    expect(block).toMatch(/slot_end_time\s+String\?/);
  });

  it('carries no site_id (no discriminator in the field set)', () => {
    const block = schema.slice(
      schema.indexOf('model MymrcDockAvailabilityMirror'),
      schema.indexOf('@@map("mymrc_dock_availability_mirror")'),
    );
    expect(block).not.toMatch(/\bsite_id\b/);
  });

  it('schema.prisma declares the model mapped to the same table', () => {
    expect(schema).toContain('model MymrcDockAvailabilityMirror');
    expect(schema).toContain('@@map("mymrc_dock_availability_mirror")');
  });
});

describe('ADR-0057 D3 — backfill cursors (resumable windowed backfill)', () => {
  const CURSOR_COLS = [
    'object_api_name',
    'list_view_api_name',
    'last_page_index',
    'last_record_id',
    'total_records_estimated',
    'records_completed',
    'started_at',
    'completed_at',
    'error',
  ];

  it('migration creates the mapped cursor table with every D3 field', () => {
    expect(migrationSql).toContain('CREATE TABLE "mymrc_backfill_cursors"');
    for (const col of CURSOR_COLS) {
      expect(migrationSql).toContain(`"${col}"`);
    }
  });

  it('migration enforces the (object, list-view) resume key', () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "mymrc_backfill_cursors_object_api_name_list_view_api_name_key" ON "mymrc_backfill_cursors"("object_api_name", "list_view_api_name")',
    );
  });

  it('NOT-NULL cursor columns all carry a DEFAULT (empty-table safe)', () => {
    expect(migrationSql).toMatch(/"list_view_api_name" TEXT NOT NULL DEFAULT ''/);
    expect(migrationSql).toMatch(/"last_page_index" INTEGER NOT NULL DEFAULT 0/);
    expect(migrationSql).toMatch(/"records_completed" INTEGER NOT NULL DEFAULT 0/);
  });

  it('schema.prisma declares the model + unique key mapped to the same table', () => {
    expect(schema).toContain('model MymrcBackfillCursor');
    expect(schema).toContain('@@map("mymrc_backfill_cursors")');
    expect(schema).toContain('@@unique([object_api_name, list_view_api_name])');
  });
});
