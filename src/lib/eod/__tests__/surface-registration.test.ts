// ADR-0125 D15 / ADR-0047 #3 — the `eod_review` surface is registered in all
// three places, and it is born PILOT.
//
// A UI gate lives in four artifacts that must agree: the `UI_SURFACE` registry,
// the migration that inserts the row, the seed that inserts it again for
// first-deploy/dev parity, and the code that reads it. Three of the four are
// checkable from here, and the shape of this test mirrors
// `src/lib/loads/ipad-surface-gates.test.ts`, which exists because they have
// drifted before.
//
// Why it matters more than usual for this one: `isUiSurfaceLive` is fail-closed,
// so an UNREGISTERED surface resolves to admin-only and looks exactly like a
// correctly-registered pilot. The failure mode of forgetting the migration is
// therefore SILENT — the screen works for admins, and Bill's /admin/rollout page
// has no row to flip.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { UI_SURFACE } from '@/lib/notify/rollout';

const ROOT = process.cwd();
const CODE = 'eod_review';

function migrationsMentioning(needle: string): string[] {
  const dir = join(ROOT, 'prisma', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        return readFileSync(join(dir, e.name, 'migration.sql'), 'utf8').includes(needle);
      } catch {
        return false;
      }
    })
    .map((e) => e.name);
}

describe('eod_review surface registration (registry ↔ migration ↔ seed)', () => {
  it('is in the UI_SURFACE registry under its documented code', () => {
    expect(UI_SURFACE.EOD_REVIEW).toBe(CODE);
  });

  it('is inserted by a migration, BORN PILOT and idempotently', () => {
    const dirs = migrationsMentioning(`'${CODE}'`);
    expect(dirs).toHaveLength(1);
    const sql = readFileSync(
      join(ROOT, 'prisma', 'migrations', dirs[0] as string, 'migration.sql'),
      'utf8',
    );
    expect(sql).toContain(`('${CODE}', 'pilot')`);
    // A replay must never revert a flip an admin has made.
    expect(sql).toContain('ON CONFLICT ("surface_code", "site_id") DO NOTHING');
    // `id` is TEXT. A uuid-typed id passes the correctness job (which does not
    // run migrations) and fails only on deploy.
    expect(sql).toContain('gen_random_uuid()::text');
    // Both sites, so the other site's state is a stated decision rather than a
    // swallowed `UnregisteredSurfaceError`.
    expect(sql).toContain(`s."code" IN ('eugene', 'woodland')`);
  });

  it('is in the seed’s PILOT list, not its LIVE list', () => {
    const seed = readFileSync(join(ROOT, 'prisma', 'seed.mjs'), 'utf8');
    const pilot = seed.slice(seed.indexOf('const UI_PILOT'), seed.indexOf('const UI_LIVE'));
    const live = seed.slice(seed.indexOf('const UI_LIVE'), seed.indexOf('const UI_LIVE') + 400);
    expect(pilot).toContain(`'${CODE}'`);
    expect(live).not.toContain(`'${CODE}'`);
  });

  it('the page and its API routes all read THIS surface, not the loads_inventory master gate', () => {
    // The whole point of D15: ramping EOD must not require ramping the manager
    // loads/inventory tabs, and pulling EOD back must not take them down.
    const files = [
      'src/app/dashboard/[site]/eod/page.tsx',
      'src/app/api/manager/[site]/eod/route.ts',
      'src/app/api/manager/[site]/eod/close/route.ts',
      'src/app/api/manager/[site]/eod/inbound/route.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).toContain('UI_SURFACE.EOD_REVIEW');
      expect(src, f).not.toContain('UI_SURFACE.LOADS_INVENTORY');
      // `requireActivatedManager` is hard-wired to the master gate; the routes
      // must use the named-surface variant.
      expect(src, f).not.toMatch(/requireActivatedManager\(/);
    }
  });
});
