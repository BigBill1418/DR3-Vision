// ADR-0071 Amendment 1 — "off" and "dead" must not be the same colour.
//
// The defect this file pins: from 2026-07-31 to 2026-08-11 the processor-quota
// cron fired every morning and the system held no evidence it had ever run,
// because the digest only selected `enabled = true` configs and the feature
// shipped disabled. The operator asked "why have I seen nothing" and nothing in
// the database could distinguish "switched off" from "never ran".
//
// Every assertion here is about that distinction. A probe that collapses the two
// states into one colour is the bug, not a cosmetic issue — an amber that means
// "off by choice" and a red that means "this stopped working" are different
// instructions to a different person.

import { describe, expect, it } from 'vitest';
import { loadProcessorQuotaHealth, QUOTA_RUN_STALE_HOURS } from './processor-quota-liveness';

const NOW = new Date('2026-08-12T14:00:00.000Z');

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

interface FakeOpts {
  configs?: { enabled: boolean }[];
  lastRun?: { ran_at: Date; configs_total: number; configs_enabled: number } | null;
}

function fakeDb(opts: FakeOpts) {
  const configs = opts.configs ?? [];
  return {
    processorQuotaConfig: {
      findMany: async () => configs,
    },
    processorQuotaRun: {
      findFirst: async () => opts.lastRun ?? null,
    },
  } as never;
}

describe('loadProcessorQuotaHealth', () => {
  it('is RED when the monitor has never run — the state that hid for 12 days', async () => {
    const h = await loadProcessorQuotaHealth(
      fakeDb({ configs: [{ enabled: false }], lastRun: null }),
      NOW,
    );
    expect(h.status).toBe('red');
    expect(h.lastRunAt).toBeNull();
    expect(h.detail).toMatch(/never run/i);
  });

  it('is RED when the last run is older than the staleness budget', async () => {
    const h = await loadProcessorQuotaHealth(
      fakeDb({
        configs: [{ enabled: true }],
        lastRun: {
          ran_at: hoursAgo(QUOTA_RUN_STALE_HOURS + 1),
          configs_total: 1,
          configs_enabled: 1,
        },
      }),
      NOW,
    );
    expect(h.status).toBe('red');
    expect(h.detail).toMatch(/has not run/i);
  });

  // The heart of the amendment. A disabled monitor that IS running is amber and
  // says so in words; it must never read as green (nothing is being watched for
  // anyone) nor as red (nothing is broken — a person chose this).
  it('is AMBER — not red, not green — when alive but every site is switched off', async () => {
    const h = await loadProcessorQuotaHealth(
      fakeDb({
        configs: [{ enabled: false }, { enabled: false }],
        lastRun: { ran_at: hoursAgo(2), configs_total: 2, configs_enabled: 0 },
      }),
      NOW,
    );
    expect(h.status).toBe('amber');
    expect(h.configsTotal).toBe(2);
    expect(h.configsEnabled).toBe(0);
    expect(h.detail).toMatch(/off/i);
    // The distinguishing evidence: it says WHEN it last ran. A dead monitor cannot.
    expect(h.lastRunAt).not.toBeNull();
  });

  it('is AMBER with a distinct reason when no site is configured at all', async () => {
    const h = await loadProcessorQuotaHealth(
      fakeDb({
        configs: [],
        lastRun: { ran_at: hoursAgo(1), configs_total: 0, configs_enabled: 0 },
      }),
      NOW,
    );
    expect(h.status).toBe('amber');
    expect(h.detail).toMatch(/no site is configured/i);
    // Unconfigured and configured-but-off are different fixes; different words.
    expect(h.detail).not.toMatch(/switched off/i);
  });

  it('is GREEN only when a site is enabled AND the monitor ran recently', async () => {
    const h = await loadProcessorQuotaHealth(
      fakeDb({
        configs: [{ enabled: true }, { enabled: false }],
        lastRun: { ran_at: hoursAgo(3), configs_total: 2, configs_enabled: 1 },
      }),
      NOW,
    );
    expect(h.status).toBe('green');
    expect(h.configsEnabled).toBe(1);
  });

  // A stopped cron on an ENABLED site is the real outage: managers believe
  // silence means everyone met quota. Staleness must outrank the enabled check.
  it('reports RED for a stale run even when a site is enabled', async () => {
    const h = await loadProcessorQuotaHealth(
      fakeDb({
        configs: [{ enabled: true }],
        lastRun: { ran_at: hoursAgo(72), configs_total: 1, configs_enabled: 1 },
      }),
      NOW,
    );
    expect(h.status).toBe('red');
  });

  // Daily firing at 06:00 PT means a 24h budget has no slack: a deploy that
  // straddles the fire minute would flip the pill red on a healthy system.
  it('tolerates a full day plus slack between runs', async () => {
    expect(QUOTA_RUN_STALE_HOURS).toBeGreaterThan(24);
    const h = await loadProcessorQuotaHealth(
      fakeDb({
        configs: [{ enabled: true }],
        lastRun: { ran_at: hoursAgo(25), configs_total: 1, configs_enabled: 1 },
      }),
      NOW,
    );
    expect(h.status).toBe('green');
  });
});
