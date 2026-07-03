// ADR-0040 D4 — weekly EIA fuel-price fetch tick.
//
// Driven once a week (Tuesday 06:00 PT) by `scripts/fuel-price-cron.mjs` → the
// internal route `/api/internal/billing/fuel-fetch`. Fetches recent weekly West-Coast
// diesel points (`eia.ts`, fail-open) and upserts each into `fuel_prices`, keyed on
// the Monday of the week.
//
// Rules (ADR-0040 D4):
//   - `source=manual` wins: a week already entered manually is NEVER overwritten by
//     an api fetch (only an explicit, audited manual overwrite replaces it — which
//     this cron never does).
//   - success is SILENT; a fetch FAILURE pages `dr3-vision-system` fingerprinted
//     `fuel-fetch-failed` with a cooldown (fleet noise policy), so a persistent
//     outage re-pages but a weekly transient does not spam. The manual-entry path
//     always remains available, so a failed fetch is a nudge, not an outage.
//
// All deps are injected so this unit-tests without network, DB, or ntfy.

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { publishNtfy, type PublishNtfyArgs, type PublishNtfyResult } from '@/lib/ntfy';
import { fetchEiaWeeklyDiesel, type EiaFetchResult } from './eia';
import { mondayOfWeekUTC } from './fuel';

// 6h cooldown: the fetch runs weekly, so this de-dupes retry bursts within a run
// while still re-paging a multi-day outage on the next weekly attempt.
const FAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface FuelFetchSummary {
  ok: boolean;
  reason?: string;
  fetched: number;
  upserted: number;
  skipped_manual: number;
  paged: boolean;
}

interface FuelPriceUpsertDb {
  fuelPrice: {
    findUnique(args: { where: { week_of: Date } }): Promise<{ source: 'eia_api' | 'manual' } | null>;
    upsert(args: {
      where: { week_of: Date };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export interface FuelFetchDeps {
  fetchEia: () => Promise<EiaFetchResult>;
  db: FuelPriceUpsertDb;
  publish: (args: PublishNtfyArgs) => Promise<PublishNtfyResult>;
  now: () => Date;
}

const defaultDeps: FuelFetchDeps = {
  fetchEia: () => fetchEiaWeeklyDiesel(),
  // The full PrismaClient satisfies the minimal FuelPriceUpsertDb surface; the cast
  // narrows to exactly the two delegates this tick uses.
  db: prisma as unknown as FuelPriceUpsertDb,
  publish: publishNtfy,
  now: () => new Date(),
};

/**
 * Run one fuel-price fetch tick. Never throws — a failure returns a summary and
 * (best-effort) pages ntfy. Success is silent.
 */
export async function runFuelFetchTick(
  overrides: Partial<FuelFetchDeps> = {},
): Promise<FuelFetchSummary> {
  const deps: FuelFetchDeps = { ...defaultDeps, ...overrides };
  const result = await deps.fetchEia();

  if (!result.ok) {
    // no_api_key is an expected, benign state (key not yet provisioned) — log it but
    // do NOT page. Real fetch failures (http/network/payload) page fingerprinted.
    const paged = result.reason !== 'no_api_key';
    if (paged) {
      await deps.publish({
        topic: 'dr3-vision-system',
        title: 'Weekly fuel price fetch failed',
        body: `EIA diesel fetch failed (${result.reason}): ${result.detail}. Enter the week's price manually if needed — invoices need it.`,
        priority: 'high',
        tags: ['warning', 'billing', 'fuel'],
        fingerprint: 'fuel-fetch-failed',
        cooldownMs: FAIL_COOLDOWN_MS,
      });
      log.warn({ reason: result.reason, detail: result.detail }, '[fuel-fetch] EIA fetch failed — paged');
    } else {
      log.info({ reason: result.reason }, '[fuel-fetch] skipped (no api key) — manual entry path unaffected');
    }
    return { ok: false, reason: result.reason, fetched: 0, upserted: 0, skipped_manual: 0, paged };
  }

  const fetchedAt = deps.now();
  let upserted = 0;
  let skippedManual = 0;
  for (const price of result.prices) {
    const weekOf = mondayOfWeekUTC(new Date(`${price.weekOf}T00:00:00Z`));
    const existing = await deps.db.fuelPrice.findUnique({ where: { week_of: weekOf } });
    if (existing?.source === 'manual') {
      skippedManual++;
      continue;
    }
    await deps.db.fuelPrice.upsert({
      where: { week_of: weekOf },
      create: {
        week_of: weekOf,
        usd_per_gal: price.usdPerGal,
        source: 'eia_api',
        fetched_at: fetchedAt,
        created_by: 'system:eia-fuel-fetch',
        note: 'EIA v2 West Coast (PADD 5) ULSD weekly retail.',
      },
      update: { usd_per_gal: price.usdPerGal, source: 'eia_api', fetched_at: fetchedAt },
    });
    upserted++;
  }

  log.info(
    { fetched: result.prices.length, upserted, skipped_manual: skippedManual },
    '[fuel-fetch] tick complete',
  );
  return {
    ok: true,
    fetched: result.prices.length,
    upserted,
    skipped_manual: skippedManual,
    paged: false,
  };
}
