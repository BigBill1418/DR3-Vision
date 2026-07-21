// ADR-0037 D7 → data-driven activation (ADR-0047) — the loads/inventory activation
// gate. Proves: admins always pass (never read the DB); operators/managers are
// blocked while the `loads_inventory` surface is pilot/unregistered (today's
// behavior, the default-safe guarantee) and pass only once it is flipped `live`.

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient, RolloutState } from '@prisma/client';
import {
  assertLoadsInventoryActivated,
  LoadsInventoryNotActivatedError,
} from './record-guards';
import { UI_SURFACE } from '@/lib/notify/rollout';

const SITE = 'site-eugene';

/**
 * A mock Prisma exposing only the read `assertLoadsInventoryActivated` performs
 * (`rolloutSurface.findUnique`, via `isUiSurfaceLive`). `row` is what the lookup
 * returns: an object for a registered surface, `null` for an unregistered one.
 * `onFind` lets a test assert the read happened (or didn't).
 */
function db(row: { rollout_state: RolloutState } | null, onFind?: () => void): PrismaClient {
  return {
    rolloutSurface: {
      findUnique: async () => {
        onFind?.();
        return row;
      },
    },
  } as unknown as PrismaClient;
}

/** A Prisma whose every access throws — proves admin never touches the DB. */
function throwingDb(): PrismaClient {
  return {
    rolloutSurface: {
      findUnique: () => {
        throw new Error('DB must not be read for an admin');
      },
    },
  } as unknown as PrismaClient;
}

describe('assertLoadsInventoryActivated', () => {
  it('registers loads_inventory as a UI surface (registry ↔ seed sync)', () => {
    expect(UI_SURFACE.LOADS_INVENTORY).toBe('loads_inventory');
  });

  it('admin always passes and never reads the DB', async () => {
    await expect(assertLoadsInventoryActivated('admin', SITE, throwingDb())).resolves.toBeUndefined();
  });

  it('blocks an operator while the surface is pilot (default/historical behavior)', async () => {
    await expect(
      assertLoadsInventoryActivated('operator', SITE, db({ rollout_state: 'pilot' })),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
  });

  it('blocks a manager while the surface is pilot', async () => {
    await expect(
      assertLoadsInventoryActivated('manager', SITE, db({ rollout_state: 'pilot' })),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
  });

  it('the block is a 403', async () => {
    await expect(
      assertLoadsInventoryActivated('operator', SITE, db({ rollout_state: 'pilot' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('default-safe: an unregistered/missing surface row blocks operators (admin-only)', async () => {
    await expect(
      assertLoadsInventoryActivated('operator', SITE, db(null)),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
  });

  it('fail-closed: a read error blocks operators rather than 500ing', async () => {
    const boom = {
      rolloutSurface: {
        findUnique: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaClient;
    await expect(
      assertLoadsInventoryActivated('operator', SITE, boom),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
  });

  it('ALLOWS an operator once the surface is flipped live', async () => {
    const spy = vi.fn();
    await expect(
      assertLoadsInventoryActivated('operator', SITE, db({ rollout_state: 'live' }, spy)),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1); // the state WAS read for a non-admin
  });

  it('ALLOWS a manager once the surface is flipped live', async () => {
    await expect(
      assertLoadsInventoryActivated('manager', SITE, db({ rollout_state: 'live' })),
    ).resolves.toBeUndefined();
  });
});
