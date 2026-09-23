// BX-12 (ADR-0137) — the site's throughput machine is DESIGNATED, never inferred.
//
// The unit half: the three states (designated / designated-none / unconfigured)
// and every way a designation can go stale. The real-database half, including the
// production regression shape (an OLDER, INVOICED `terex`-category shear at the
// same site), is `site-machine.db.test.ts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface EquipRow {
  id: string;
  display_name: string;
  site_id: string | null;
  is_active: boolean;
  merged_into_id: string | null;
}

const store = {
  designations: new Map<string, string | null>(),
  equipment: new Map<string, EquipRow>(),
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteThroughputMachine: {
      findUnique: async ({ where }: { where: { site_id: string } }) =>
        store.designations.has(where.site_id)
          ? { equipment_id: store.designations.get(where.site_id) ?? null }
          : null,
    },
    equipment: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = store.equipment.get(where.id);
        return row ? { ...row } : null;
      },
      // A resolver that went back to inferring would call this; it must not.
      findFirst: () => {
        throw new Error('resolveSiteThroughputMachine must not infer the machine');
      },
    },
  },
}));

import { ThroughputMachineNotConfiguredError, resolveSiteThroughputMachine } from './site-machine';

const WDL = 'site-woodland';
const EUG = 'site-eugene';
const TEREX: EquipRow = {
  id: 'eq-terex',
  display_name: 'Terex',
  site_id: WDL,
  is_active: true,
  merged_into_id: null,
};

beforeEach(() => {
  store.designations.clear();
  store.equipment.clear();
  store.equipment.set(TEREX.id, { ...TEREX });
  store.designations.set(WDL, TEREX.id);
  store.designations.set(EUG, null);
});

describe('resolveSiteThroughputMachine (BX-12)', () => {
  it('returns the designated machine', async () => {
    expect(await resolveSiteThroughputMachine(WDL)).toEqual({
      id: 'eq-terex',
      displayName: 'Terex',
    });
  });

  it('returns null for a site designated as having NO machine (Eugene)', async () => {
    expect(await resolveSiteThroughputMachine(EUG)).toBeNull();
  });

  it('THROWS for a site with no designation — never a guess', async () => {
    store.designations.delete(WDL);
    const err = await resolveSiteThroughputMachine(WDL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThroughputMachineNotConfiguredError);
    expect((err as ThroughputMachineNotConfiguredError).status).toBe(503);
    expect((err as Error).message).toMatch(/throughput_machine_not_configured/);
  });

  it.each([
    ['merged away', { merged_into_id: 'eq-other' }],
    ['deactivated', { is_active: false }],
    ['moved to the other site', { site_id: EUG }],
    ['made fleet-wide', { site_id: null }],
  ])('THROWS when the designated row was %s', async (_label, patch) => {
    store.equipment.set(TEREX.id, { ...TEREX, ...patch });
    await expect(resolveSiteThroughputMachine(WDL)).rejects.toBeInstanceOf(
      ThroughputMachineNotConfiguredError,
    );
  });

  it('THROWS when the designated row no longer exists', async () => {
    store.equipment.clear();
    await expect(resolveSiteThroughputMachine(WDL)).rejects.toBeInstanceOf(
      ThroughputMachineNotConfiguredError,
    );
  });
});
