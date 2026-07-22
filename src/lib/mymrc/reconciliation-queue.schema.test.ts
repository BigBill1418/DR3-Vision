import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Schema-foundation parity guard for ADR-0057 D4 (reconciliation queue) +
// ADR-0056 amendment (Addendum A §A.3, `collection_events.dr3_hauled`).
// Text-based, DB-free — mirrors the credential-store `migration / schema parity`
// suite. Locks the hand-authored 20260803 migration to the Prisma models so a
// later edit to one without the other fails CI.
describe('ADR-0057 D4 reconciliation queue — migration / schema parity', () => {
  const root = process.cwd();
  const migrationSql = readFileSync(
    resolve(root, 'prisma/migrations/20260803_adr0057_reconciliation_queue/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');

  const QUEUE_COLUMNS = [
    'id',
    'mirror_table',
    'mirror_record_id',
    'target_table',
    'target_record_id',
    'field_name',
    'mymrc_value',
    'vision_value',
    'change_kind',
    'status',
    'created_at',
    'decided_at',
    'decided_by',
    'decision_note',
    'snooze_until',
  ];

  it('migration creates the mapped queue table with every column', () => {
    expect(migrationSql).toContain('CREATE TABLE "mymrc_reconciliation_queue"');
    for (const col of QUEUE_COLUMNS) {
      expect(migrationSql).toContain(`"${col}"`);
    }
  });

  it('migration creates both enums with the exact D4 value sets', () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "ReconChangeKind" AS ENUM ('new_record', 'field_update', 'disappeared')`,
    );
    expect(migrationSql).toContain(
      `CREATE TYPE "ReconStatus" AS ENUM ('pending', 'approved', 'rejected', 'snoozed')`,
    );
  });

  it('migration nullability matches D4: mymrc_value required, vision_value optional', () => {
    expect(migrationSql).toContain('"mymrc_value" JSONB NOT NULL');
    // vision_value is nullable — declared without NOT NULL
    expect(migrationSql).toMatch(/"vision_value" JSONB(?!\s+NOT NULL)/);
  });

  it('migration defaults status to pending', () => {
    expect(migrationSql).toContain(`"status" "ReconStatus" NOT NULL DEFAULT 'pending'`);
  });

  it('migration creates the three D4 query indexes', () => {
    expect(migrationSql).toContain(
      '"mymrc_reconciliation_queue"("status", "mirror_table", "change_kind")',
    );
    expect(migrationSql).toContain(
      '"mymrc_reconciliation_queue"("mirror_table", "mirror_record_id")',
    );
    expect(migrationSql).toContain(
      '"mymrc_reconciliation_queue"("target_table", "target_record_id")',
    );
  });

  it('schema.prisma declares the model + enums mapped to the same table', () => {
    expect(schema).toContain('model MymrcReconciliationQueue');
    expect(schema).toContain('@@map("mymrc_reconciliation_queue")');
    expect(schema).toContain('enum ReconChangeKind');
    expect(schema).toContain('enum ReconStatus');
    expect(schema).toContain('status           ReconStatus     @default(pending)');
  });

  it('does NOT collide with the pre-existing ADR-0038 CSV-compliance reconciliation models', () => {
    // Distinct feature — must keep its own map name, never repurpose these.
    expect(schema).toContain('@@map("mymrc_reconciliations")');
    expect(schema).toContain('@@map("mymrc_reconciliation_items")');
    expect(schema).toContain('@@map("mymrc_reconciliation_queue")');
  });
});

describe('ADR-0056 amendment §A.3 — collection_events.dr3_hauled gate', () => {
  const root = process.cwd();
  const migrationSql = readFileSync(
    resolve(root, 'prisma/migrations/20260803_adr0057_reconciliation_queue/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');

  it('migration adds a NOT NULL dr3_hauled column defaulting true (billing-safe backfill)', () => {
    expect(migrationSql).toContain(
      'ADD COLUMN "dr3_hauled" BOOLEAN NOT NULL DEFAULT true',
    );
  });

  it('schema.prisma declares dr3_hauled Boolean @default(true) on CollectionEvent', () => {
    expect(schema).toMatch(/dr3_hauled\s+Boolean\s+@default\(true\)/);
  });
});
