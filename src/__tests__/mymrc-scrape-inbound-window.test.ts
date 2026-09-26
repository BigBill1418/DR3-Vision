// OPEN-ITEMS 0.CA (2026-09-25) — the hourly INBOUND bridge must window on the
// same span the sync re-reads delivered hauls over. 73f3002 made the mirror absorb
// MRC corrections to hauls delivered in the last 45 days, but the bridge kept its
// 10-day window, so a correction to a day 11-45 days back (09-15, +107) reached
// the mirror and never reached `inbound_loads` — the floor stayed wrong until a
// hand-run backfill, whose gate then paged "MyMRC sync error".

import { describe, expect, it, vi } from 'vitest';
import {
  runMymrcScrape,
  inboundBridgeFloor,
  recentProcessedFloor,
  DEFAULT_INBOUND_BRIDGE_WINDOW_MS,
} from '../../scripts/mymrc-scrape.mjs';
import { CredentialsNotConfiguredError, DELIVERED_REDETAIL_WINDOW_MS } from '@/lib/mymrc';

const DAY = 86_400_000;

describe('inboundBridgeFloor', () => {
  it('reaches back the whole re-detail window (+1 day of zone slack), not the 10-day processed window', () => {
    // The 7:38 PM PDT 09-25 tick that re-read H-139112 ran at 02:39Z on 09-26.
    const now = new Date('2026-09-26T02:39:23.000Z');
    expect(inboundBridgeFloor(now, 45 * DAY).toISOString()).toBe('2026-08-11T00:00:00.000Z');
    // 09-15 — the day the 0.BZ correction landed on — is inside it; it was not
    // inside the old one (floor 09-16, and the bridge compares UTC day keys).
    expect(inboundBridgeFloor(now, 45 * DAY).getTime()).toBeLessThanOrEqual(Date.UTC(2026, 8, 15));
    expect(recentProcessedFloor(now).getTime()).toBeGreaterThan(Date.UTC(2026, 8, 15));
  });
  it('falls back to 45 days when the bundle does not export the window', () => {
    const now = new Date('2026-09-26T02:39:23.000Z');
    expect(inboundBridgeFloor(now, undefined)).toEqual(inboundBridgeFloor(now, 45 * DAY));
    expect(DEFAULT_INBOUND_BRIDGE_WINDOW_MS).toBe(45 * DAY);
  });
  it('the fallback equals the live sync constant, so the two cannot silently diverge', () => {
    expect(DEFAULT_INBOUND_BRIDGE_WINDOW_MS).toBe(DELIVERED_REDETAIL_WINDOW_MS);
  });
});

describe('runMymrcScrape — the hourly inbound bridge uses the re-detail window', () => {
  it('passes the re-detail floor to BOTH bridges (inbound sinceDeliveryDate, processed sinceProductionDate)', async () => {
    const bridge = vi.fn(async () => ({
      daysConsidered: 0,
      inserted: 0,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
      haulsUndated: 0,
      skippedPerLoad: 0,
      writes: [],
    }));
    const processed = vi.fn(async () => ({
      inserted: 0,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
    }));
    const fakeClient = { close: vi.fn(async () => undefined), getSession: vi.fn(() => ({})) };
    const mymrc = {
      setCooldownDb: vi.fn(),
      CredentialsNotConfiguredError,
      loadAdminCredentials: vi.fn(async () => ({ username: 'u', password: 'p' })),
      createPortalClient: vi.fn(async () => fakeClient),
      playwrightRecordFieldsSession: vi.fn(() => ({})),
      createRecordFieldsClient: vi.fn(() => ({ fetchRecordFields: vi.fn() })),
      syncSite: vi.fn(async ({ site }: { site: string }) => [
        { feed: 'hauls', status: 'ok', rowsListed: 3, detailsFetched: 1, site },
      ]),
      checkDeadman: vi.fn(async () => undefined),
      SITE_CODES: ['eugene', 'woodland'],
      ntfyPager: { page: vi.fn(async () => undefined) },
      DELIVERED_REDETAIL_WINDOW_MS: 45 * DAY,
      bridgeInboundHaulsToInventory: bridge,
      bridgeProcessedToInventory: processed,
    };
    const before = Date.now();
    await runMymrcScrape({
      mymrc,
      prisma: {},
      launchBrowser: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
      log: () => undefined,
    });
    expect(bridge).toHaveBeenCalledTimes(1);
    const arg = (bridge.mock.calls[0] as unknown as [{ sinceDeliveryDate: Date }])[0];
    expect(arg.sinceDeliveryDate).toEqual(inboundBridgeFloor(new Date(before), 45 * DAY));
    expect(processed).toHaveBeenCalledTimes(1);
    const parg = (processed.mock.calls[0] as unknown as [{ sinceProductionDate: Date }])[0];
    expect(parg.sinceProductionDate).toEqual(inboundBridgeFloor(new Date(before), 45 * DAY));
  });
});
