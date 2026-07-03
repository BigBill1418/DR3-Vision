// ADR-0040 D6 — rate variance report (the renegotiation exhibit, as a living artifact).
//
// Per trans-charge source: its CURRENT freight tier (priced on `Source.canonical_mileage`)
// vs the tier it was LAST BILLED under (the pre-06-09-diversion Stockton-era mileage).
// The delta per haul × hauls/month = the monthly leakage this ADR quantifies (freight
// billed on stale mileage since the diversion, +34%→+1240% actual-distance deltas).
//
// LAST-BILLED SOURCE (ADR-0040 D6): "last billed" mileage + haul frequency come from
// workbook-import / invoice history. Those staging tables are being introduced by the
// ADR-0039 audit engine and are NOT on `main` at this build. So this module reads that
// history through an injected {@link VarianceProvider} seam. The default
// `UNAVAILABLE_PROVIDER` reports `available:false`; the report then renders tier-NOW
// only, with an honest empty state (the UI shows a TODO banner). When the audit
// engine's workbook staging lands, implement a provider over it — nothing else changes.

import { prisma } from '@/lib/prisma';

export type FreightJurisdiction = 'CA' | 'OR';

/** Last-billed billing history for one source (from workbook/invoice import). */
export interface SourceBillingHistory {
  /** The mileage the source was most recently billed freight under, or null. */
  lastBilledMileage: number | null;
  /** Average transport-charged hauls per month for the source, or null. */
  haulsPerMonth: number | null;
}

export interface VarianceProvider {
  /** False when no workbook/invoice history is available (the current `main` state). */
  available: boolean;
  historyFor(sourceId: string): SourceBillingHistory;
}

/**
 * The default provider: no workbook/invoice history on `main` yet (ADR-0039 audit-engine
 * staging tables not present). TODO(ADR-0040 D6): replace with a provider that reads the
 * audit engine's workbook staging once it lands, returning real last-billed mileage +
 * haul frequency per source.
 */
export const UNAVAILABLE_PROVIDER: VarianceProvider = {
  available: false,
  historyFor: () => ({ lastBilledMileage: null, haulsPerMonth: null }),
};

export interface VarianceRow {
  source_id: string;
  source_name: string;
  jurisdiction: FreightJurisdiction;
  canonical_mileage: number | null;
  tier_now_cents: number | null;
  last_billed_mileage: number | null;
  tier_last_cents: number | null;
  per_haul_delta_cents: number | null;
  hauls_per_month: number | null;
  monthly_leakage_cents: number | null;
  /** Short human note when a value could not be computed (e.g. no tier for mileage). */
  note: string | null;
}

export interface VarianceReport {
  provider_available: boolean;
  as_of: string; // YYYY-MM-DD
  rows: VarianceRow[];
  total_monthly_leakage_cents: number;
}

// ── Minimal DB surface (a Prisma client satisfies it) ──

interface VarianceSourceRow {
  id: string;
  name: string;
  canonical_mileage: number | null;
  site: { jurisdiction: 'california' | 'oregon' } | null;
}
interface VarianceTierRow {
  min_miles: number;
  max_miles: number;
  rate_cents: number;
  effective_from: Date;
  effective_to: Date | null;
}
export interface VarianceDb {
  source: {
    findMany(args: {
      where: { is_trans_charge: true; is_active: true };
      select: { id: true; name: true; canonical_mileage: true; site: { select: { jurisdiction: true } } };
      orderBy: { name: 'asc' };
    }): Promise<VarianceSourceRow[]>;
  };
  transportRateTier: {
    findMany(args: {
      where: {
        jurisdiction: FreightJurisdiction;
        min_miles: { lte: number };
        max_miles: { gte: number };
        effective_from: { lte: Date };
        OR: Array<{ effective_to: null } | { effective_to: { gte: Date } }>;
      };
      orderBy: { effective_from: 'desc' };
    }): Promise<VarianceTierRow[]>;
  };
}

function dateUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function jurisdictionOf(site: { jurisdiction: 'california' | 'oregon' }): FreightJurisdiction {
  return site.jurisdiction === 'california' ? 'CA' : 'OR';
}

async function tierCentsFor(
  db: VarianceDb,
  jurisdiction: FreightJurisdiction,
  mileage: number,
  on: Date,
): Promise<number | null> {
  const tiers = await db.transportRateTier.findMany({
    where: {
      jurisdiction,
      min_miles: { lte: mileage },
      max_miles: { gte: mileage },
      effective_from: { lte: on },
      OR: [{ effective_to: null }, { effective_to: { gte: on } }],
    },
    orderBy: { effective_from: 'desc' },
  });
  return tiers[0]?.rate_cents ?? null;
}

export interface BuildVarianceArgs {
  date: Date;
  provider?: VarianceProvider;
  db?: VarianceDb;
}

/**
 * Build the variance report over every active trans-charge source. Pure of side
 * effects (read-only). When the provider is unavailable, last-billed / delta / leakage
 * columns are null and `total_monthly_leakage_cents` is 0 — the tier-now column still
 * populates so the report is useful the moment tiers are seeded.
 */
export async function buildVarianceReport(args: BuildVarianceArgs): Promise<VarianceReport> {
  const db = args.db ?? (prisma as unknown as VarianceDb);
  const provider = args.provider ?? UNAVAILABLE_PROVIDER;
  const on = dateUTC(args.date);
  const asOf = on.toISOString().slice(0, 10);

  const sources = await db.source.findMany({
    where: { is_trans_charge: true, is_active: true },
    select: { id: true, name: true, canonical_mileage: true, site: { select: { jurisdiction: true } } },
    orderBy: { name: 'asc' },
  });

  const rows: VarianceRow[] = [];
  let totalLeakage = 0;

  for (const s of sources) {
    const jurisdiction = s.site ? jurisdictionOf(s.site) : 'CA';
    const row: VarianceRow = {
      source_id: s.id,
      source_name: s.name,
      jurisdiction,
      canonical_mileage: s.canonical_mileage,
      tier_now_cents: null,
      last_billed_mileage: null,
      tier_last_cents: null,
      per_haul_delta_cents: null,
      hauls_per_month: null,
      monthly_leakage_cents: null,
      note: null,
    };

    if (s.canonical_mileage == null) {
      row.note = 'no canonical mileage on file';
      rows.push(row);
      continue;
    }
    row.tier_now_cents = await tierCentsFor(db, jurisdiction, s.canonical_mileage, on);
    if (row.tier_now_cents == null) {
      row.note = jurisdiction === 'OR' ? 'no OR freight tiers seeded' : 'no tier band for mileage';
    }

    if (provider.available) {
      const hist = provider.historyFor(s.id);
      row.last_billed_mileage = hist.lastBilledMileage;
      row.hauls_per_month = hist.haulsPerMonth;
      if (hist.lastBilledMileage != null) {
        row.tier_last_cents = await tierCentsFor(db, jurisdiction, hist.lastBilledMileage, on);
      }
      if (row.tier_now_cents != null && row.tier_last_cents != null) {
        row.per_haul_delta_cents = row.tier_now_cents - row.tier_last_cents;
        if (hist.haulsPerMonth != null) {
          row.monthly_leakage_cents = row.per_haul_delta_cents * hist.haulsPerMonth;
          totalLeakage += row.monthly_leakage_cents;
        }
      }
    }
    rows.push(row);
  }

  return {
    provider_available: provider.available,
    as_of: asOf,
    rows,
    total_monthly_leakage_cents: totalLeakage,
  };
}

/** Render a variance report as CSV (money columns in dollars, 2dp). */
export function varianceToCsv(report: VarianceReport): string {
  const header = [
    'source',
    'jurisdiction',
    'canonical_mileage',
    'tier_now_usd',
    'last_billed_mileage',
    'tier_last_usd',
    'per_haul_delta_usd',
    'hauls_per_month',
    'monthly_leakage_usd',
    'note',
  ];
  const dollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));
  const num = (n: number | null) => (n == null ? '' : String(n));
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header.join(',')];
  for (const r of report.rows) {
    lines.push(
      [
        esc(r.source_name),
        r.jurisdiction,
        num(r.canonical_mileage),
        dollars(r.tier_now_cents),
        num(r.last_billed_mileage),
        dollars(r.tier_last_cents),
        dollars(r.per_haul_delta_cents),
        num(r.hauls_per_month),
        dollars(r.monthly_leakage_cents),
        esc(r.note ?? ''),
      ].join(','),
    );
  }
  lines.push(['TOTAL', '', '', '', '', '', '', '', dollars(report.total_monthly_leakage_cents), ''].join(','));
  return `${lines.join('\n')}\n`;
}
