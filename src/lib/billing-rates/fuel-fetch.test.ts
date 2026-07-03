// ADR-0040 D4 — fuel-fetch tick tests. All deps injected (no network/DB/ntfy).
// Covers: manual rows are never overwritten by the api fetch; a fetch failure pages
// fingerprinted; no_api_key is silent (no page); success upserts eia_api rows.

import { describe, it, expect, vi } from 'vitest';
import { runFuelFetchTick, type FuelFetchDeps } from './fuel-fetch';
import type { EiaFetchResult } from './eia';
import type { PublishNtfyArgs, PublishNtfyResult } from '@/lib/ntfy';

function makeDb(existing: Record<string, 'eia_api' | 'manual'>) {
  const upserts: Array<{ week: string; source: unknown }> = [];
  const db: FuelFetchDeps['db'] = {
    fuelPrice: {
      findUnique: async ({ where }) => {
        const key = where.week_of.toISOString().slice(0, 10);
        return existing[key] ? { source: existing[key]! } : null;
      },
      upsert: async ({ where, create }) => {
        upserts.push({ week: where.week_of.toISOString().slice(0, 10), source: create['source'] });
        return {};
      },
    },
  };
  return { db, upserts };
}

const NOW = () => new Date('2026-07-07T13:00:00Z');

describe('runFuelFetchTick — success path', () => {
  it('upserts eia_api rows for fetched weeks', async () => {
    const { db, upserts } = makeDb({});
    const publish = vi.fn<(args: PublishNtfyArgs) => Promise<PublishNtfyResult>>(async () => ({
    ok: true,
    outcome: 'sent',
  }));
    const fetchEia = async (): Promise<EiaFetchResult> => ({
      ok: true,
      prices: [
        { weekOf: '2026-06-29', usdPerGal: 5.85 },
        { weekOf: '2026-06-22', usdPerGal: 5.42 },
      ],
    });
    const summary = await runFuelFetchTick({ db, publish, fetchEia, now: NOW });
    expect(summary).toMatchObject({ ok: true, fetched: 2, upserted: 2, skipped_manual: 0, paged: false });
    expect(upserts.map((u) => u.week)).toEqual(['2026-06-29', '2026-06-22']);
    expect(publish).not.toHaveBeenCalled();
  });

  it('never overwrites a manual row with an api fetch', async () => {
    const { db, upserts } = makeDb({ '2026-06-29': 'manual' });
    const fetchEia = async (): Promise<EiaFetchResult> => ({
      ok: true,
      prices: [{ weekOf: '2026-06-29', usdPerGal: 9.99 }],
    });
    const summary = await runFuelFetchTick({ db, fetchEia, now: NOW, publish: async () => ({ ok: true, outcome: 'sent' }) });
    expect(summary).toMatchObject({ ok: true, upserted: 0, skipped_manual: 1 });
    expect(upserts).toHaveLength(0);
  });
});

describe('runFuelFetchTick — failure paths', () => {
  it('pages fingerprinted on a real fetch failure', async () => {
    const { db } = makeDb({});
    const publish = vi.fn<(args: PublishNtfyArgs) => Promise<PublishNtfyResult>>(async () => ({
    ok: true,
    outcome: 'sent',
  }));
    const fetchEia = async (): Promise<EiaFetchResult> => ({ ok: false, reason: 'http_error', detail: 'HTTP 500' });
    const summary = await runFuelFetchTick({ db, publish, fetchEia, now: NOW });
    expect(summary).toMatchObject({ ok: false, reason: 'http_error', paged: true });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0]).toMatchObject({ fingerprint: 'fuel-fetch-failed', topic: 'dr3-vision-system' });
  });

  it('does NOT page when the api key is simply absent', async () => {
    const { db } = makeDb({});
    const publish = vi.fn<(args: PublishNtfyArgs) => Promise<PublishNtfyResult>>(async () => ({
    ok: true,
    outcome: 'sent',
  }));
    const fetchEia = async (): Promise<EiaFetchResult> => ({ ok: false, reason: 'no_api_key', detail: 'EIA_API_KEY is not set' });
    const summary = await runFuelFetchTick({ db, publish, fetchEia, now: NOW });
    expect(summary).toMatchObject({ ok: false, reason: 'no_api_key', paged: false });
    expect(publish).not.toHaveBeenCalled();
  });
});
