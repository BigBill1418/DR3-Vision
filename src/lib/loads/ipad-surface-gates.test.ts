// ADR-0065 — per-surface iPad rollout gates.
//
// The property that matters: each iPad surface resolves its OWN row, so turning
// one off cannot turn another off, and — critically — cannot drop the manager
// desktop, which keeps reading the shared `loads_inventory` master gate.

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient, RolloutState } from '@prisma/client';
import {
  assertUiSurfaceActivated,
  assertLoadsInventoryActivated,
  LoadsInventoryNotActivatedError,
} from './record-guards';
import { UI_SURFACE } from '@/lib/notify/rollout';

const SITE = 'site-eugene';

/**
 * A Prisma stub backed by a per-surface state map — the shape that actually
 * exercises "one surface off, the others on". `isUiSurfaceLive` reads
 * `rolloutSurface.findUnique({ where: { surface_code_site_id: {...} } })`.
 */
function dbWith(states: Record<string, RolloutState>): PrismaClient {
  return {
    rolloutSurface: {
      findUnique: async (args: { where: { surface_code_site_id: { surface_code: string } } }) => {
        const code = args.where.surface_code_site_id.surface_code;
        const state = states[code];
        return state ? { rollout_state: state } : null; // absent ⇒ unregistered
      },
    },
  } as unknown as PrismaClient;
}

/** Bill's decision as of 2026-07-28 — what the migration seeds. */
const SEEDED: Record<string, RolloutState> = {
  [UI_SURFACE.IPAD_QUEUE]: 'live',
  [UI_SURFACE.IPAD_INBOUND]: 'live',
  [UI_SURFACE.IPAD_COUNT]: 'pilot',
  [UI_SURFACE.IPAD_PROCESSED]: 'pilot',
  [UI_SURFACE.IPAD_TODAY_SUMMARY]: 'pilot',
  [UI_SURFACE.LOADS_INVENTORY]: 'live',
};

describe('ADR-0065 per-surface iPad gates', () => {
  it('registers all five iPad surfaces (registry ↔ migration ↔ seed sync)', () => {
    expect(UI_SURFACE.IPAD_QUEUE).toBe('ipad_queue');
    expect(UI_SURFACE.IPAD_INBOUND).toBe('ipad_inbound');
    expect(UI_SURFACE.IPAD_COUNT).toBe('ipad_count');
    expect(UI_SURFACE.IPAD_PROCESSED).toBe('ipad_processed');
    expect(UI_SURFACE.IPAD_TODAY_SUMMARY).toBe('ipad_today_summary');
  });

  it('lets an operator through the LIVE surfaces (queue + inbound)', async () => {
    const db = dbWith(SEEDED);
    await expect(
      assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_QUEUE, SITE, db),
    ).resolves.toBeUndefined();
    await expect(
      assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_INBOUND, SITE, db),
    ).resolves.toBeUndefined();
  });

  it('blocks an operator on the PILOT surfaces (count / processed / summary)', async () => {
    const db = dbWith(SEEDED);
    for (const code of [
      UI_SURFACE.IPAD_COUNT,
      UI_SURFACE.IPAD_PROCESSED,
      UI_SURFACE.IPAD_TODAY_SUMMARY,
    ]) {
      await expect(assertUiSurfaceActivated('operator', code, SITE, db)).rejects.toBeInstanceOf(
        LoadsInventoryNotActivatedError,
      );
    }
  });

  it('does NOT drop the manager desktop when an iPad surface is turned off', async () => {
    // The whole reason for the split: `loads_inventory` also fronts the manager
    // loads-inventory + processed-units-close tabs and every loads write. Turning
    // the iPad queue off must leave the manager gate untouched.
    const db = dbWith({ ...SEEDED, [UI_SURFACE.IPAD_QUEUE]: 'pilot' });

    await expect(
      assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_QUEUE, SITE, db),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
    await expect(assertLoadsInventoryActivated('manager', SITE, db)).resolves.toBeUndefined();
  });

  it('is per-surface, not all-or-nothing: turning one off leaves the others live', async () => {
    const db = dbWith({ ...SEEDED, [UI_SURFACE.IPAD_INBOUND]: 'pilot' });
    await expect(
      assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_INBOUND, SITE, db),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
    await expect(
      assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_QUEUE, SITE, db),
    ).resolves.toBeUndefined();
  });

  it('fails CLOSED for an unregistered surface', async () => {
    await expect(
      assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_COUNT, SITE, dbWith({})),
    ).rejects.toBeInstanceOf(LoadsInventoryNotActivatedError);
  });

  it('lets an admin through every surface without reading the DB', async () => {
    const spy = vi.fn();
    const throwing = {
      rolloutSurface: {
        findUnique: () => {
          spy();
          throw new Error('DB must not be read for an admin');
        },
      },
    } as unknown as PrismaClient;

    for (const code of Object.values(UI_SURFACE)) {
      await expect(
        assertUiSurfaceActivated('admin', code, SITE, throwing),
      ).resolves.toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
