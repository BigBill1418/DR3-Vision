// ADR-0143 D2 — every writer of an inventory leg runs the pool guard.
//
// The defect this pins (RC2): the only write-time negative check sat in
// `closeProcessedUnitsDay`, a door Woodland used 0 of 33 days. ADR-0110 D5 named the
// class: "a gated capability is only as gated as its least guarded entry point".
// This scan finds every file that WRITES one of the six leg tables and requires one
// of:
//   - it calls `guardPoolsInTx(` (the in-transaction check), or
//   - it carries a `pool-guard: post-tick` note (the standalone MyMRC bridges, checked
//     by the 10-minute pool-check sweep), or
//   - it carries a `pool-guard: non-moving` note with a reason (it writes the table
//     but provably never moves a pool).
// A new writer with none of these fails CI. The scan asserts how many writers it
// found, so a regex that silently matches nothing goes red.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const DELEGATE_WRITE_RE =
  /\.(processedUnitsDaily|inboundLoad|consumerDropoff|outboundMaterial|landfilledUnit|siteInventorySnapshot)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
const RAW_WRITE_RE =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(processed_units_daily|inbound_loads|consumer_dropoffs|outbound_materials|landfilled_units|site_inventory_snapshots)\b/i;
const GUARD_CALL_RE = /\bguardPoolsInTx\s*\(/;
const NOTE_RE = /pool-guard:[ \t]*(post-tick|non-moving)[ \t]+—[ \t]+\S[^\n]{20,}/;

function isTest(p: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(p) || p.includes('/__tests__/') || p.includes('/__fixtures__/')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

export interface SourceFile {
  path: string;
  content: string;
}

export function isLegWriter(f: SourceFile): boolean {
  return !isTest(f.path) && (DELEGATE_WRITE_RE.test(f.content) || RAW_WRITE_RE.test(f.content));
}

export function unguardedWriters(files: readonly SourceFile[]): string[] {
  return files
    .filter(isLegWriter)
    .filter((f) => !GUARD_CALL_RE.test(f.content) && !NOTE_RE.test(f.content))
    .map((f) => f.path);
}

describe('ADR-0143 D2 — every inventory-leg writer runs the pool guard', () => {
  const files = walk(join(ROOT, 'src')).map((abs) => ({
    path: relative(ROOT, abs).split(sep).join('/'),
    content: readFileSync(abs, 'utf-8'),
  }));

  it('finds the writers (the scan is not vacuous) and every one is guarded or annotated', () => {
    const writers = files.filter(isLegWriter).map((f) => f.path);
    expect(writers.length).toBeGreaterThanOrEqual(15);
    // The Woodland door and the two MyMRC bridges are always in the set.
    expect(writers).toEqual(
      expect.arrayContaining([
        'src/lib/workbook-sync/upsert.ts',
        'src/lib/mymrc/processed-bridge.ts',
        'src/lib/mymrc/inbound-bridge.ts',
        'src/lib/loads/processed-units.ts',
      ]),
    );
    expect(unguardedWriters(files)).toEqual([]);
  });

  it('the post-tick sweep the bridges rely on exists and runs the guard', () => {
    const route = files.find(
      (f) => f.path === 'src/app/api/internal/inventory/pool-check/route.ts',
    );
    expect(route?.content).toMatch(/runPoolCheck\(/);
    const daemon = readFileSync(join(ROOT, 'scripts/inventory-pool-check-cron.mjs'), 'utf-8');
    expect(daemon).toContain('/api/internal/inventory/pool-check');
    // 2026-10-29: the sweep must run in a service the deployer RECREATES on every
    // deploy. It first rode the profile-gated workbook-sync daemon, which the
    // deployer never starts (live COMPOSE_PROFILES=ap), and shipped dead.
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf-8');
    const block = compose
      .split(/\n  (?=[a-z][a-z0-9-]*:\n)/)
      .find((b) => b.includes("command: ['node', 'scripts/inventory-pool-check-cron.mjs']"));
    expect(block, 'a compose service runs the pool-check daemon').toBeDefined();
    expect(block).not.toMatch(/^\s*profiles:/m);
  });

  it('test-of-the-test: a new unguarded writer is caught; a bare note does not excuse one', () => {
    const planted: SourceFile[] = [
      {
        path: 'src/lib/new/landfill-import.ts',
        content: 'await tx.landfilledUnit.createMany({ data });\n',
      },
      {
        path: 'src/lib/new/raw.ts',
        content: 'await tx.$executeRaw`UPDATE processed_units_daily SET x = 1`;\n',
      },
      {
        path: 'src/lib/new/noted.ts',
        content: '// pool-guard: non-moving —\nawait db.inboundLoad.update({});\n',
      },
      {
        path: 'src/lib/new/guarded.ts',
        content: 'await tx.consumerDropoff.create({});\nawait guardPoolsInTx(tx, s, w);\n',
      },
      { path: 'src/lib/new/reader.ts', content: 'await db.landfilledUnit.aggregate({});\n' },
    ];
    expect(unguardedWriters(planted)).toEqual([
      'src/lib/new/landfill-import.ts',
      'src/lib/new/raw.ts',
      'src/lib/new/noted.ts',
    ]);
  });
});
