// ADR-0057 Addendum A (§A.4 / §A.5 / §A.8.2) — seed-path guards. seed.mjs is plain
// node ESM (prod runs it for dev/CI parity); these assert its Addendum-A behavior
// against the source text (same idiom as addendum-b-data.test.ts on migration.sql):
//   • §A.5 Xtraction × metal = 0.8100 is seeded EXACTLY (verify only, no change)
//   • §A.4 Covanta is seeded as an INACTIVE vendor with NO rate
//   • §A.8.2 CA office aliases are wired into seedSourceAliases

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const seedSrc = readFileSync(join(REPO_ROOT, 'prisma/seed.mjs'), 'utf8');

describe('§A.5 — Xtraction recycling rate (verify only)', () => {
  it('seeds Xtraction × metal at exactly 0.8100 (81% steel / 19% landfill)', () => {
    // The confirmed rate (recon + model doc + OPEN-ITEMS S-7). Assert the exact triple
    // so a future edit to the seed rates array can never silently drift it.
    expect(seedSrc).toMatch(
      /vendor:\s*'Xtraction',\s*commodity:\s*'metal',\s*percent:\s*'0\.8100'/,
    );
  });
});

describe('§A.4 — Covanta seeded inactive with no rate', () => {
  it('upserts Covanta with is_active:false', () => {
    expect(seedSrc).toMatch(/where:\s*\{\s*name:\s*'Covanta'\s*\}/);
    expect(seedSrc).toMatch(/name:\s*'Covanta',\s*is_active:\s*false/);
    expect(seedSrc).toMatch(/update:\s*\{\s*is_active:\s*false\s*\}/);
  });

  it('never seeds a recycling rate for Covanta (a WTE % is not a recycling %)', () => {
    // Covanta must not appear in the confirmed `rates` array (Green Zone / Xtraction /
    // Biomass only). A rate row for Covanta would over-report recovery to CalRecycle.
    const ratesArray = seedSrc.slice(seedSrc.indexOf('const rates = ['), seedSrc.indexOf('];', seedSrc.indexOf('const rates = [')));
    expect(ratesArray).not.toMatch(/Covanta/);
  });
});

describe('§A.8.2 — CA office aliases wired into the seed', () => {
  it('imports and seeds CA_OFFICE_SOURCE_ALIASES on the woodland site', () => {
    expect(seedSrc).toMatch(/CA_OFFICE_SOURCE_ALIASES/);
    expect(seedSrc).toMatch(/seedAliasesForSite\(woodland,\s*CA_OFFICE_SOURCE_ALIASES\)/);
  });
});
