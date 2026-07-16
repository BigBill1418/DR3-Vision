// M3 — Commodity payment aging (ADR-0052). Outbound loads whose payment
// tracking has stalled: `awaiting_invoice` beyond `aging_ship_days` since ship
// (D1: 30), or `invoiced` beyond `aging_invoice_days` since invoice date
// (D1: 45). `disputed` loads are EXCLUDED (actively worked, not stale) and
// `paid` loads never age.
//
// D3 — findings roll up PER BUYER: one finding per (site, buyer) per run
// listing that buyer's aging loads (fingerprint keys `[siteId, buyer]`), so a
// buyer with 14 stale loads is one digest line, and the finding auto-resolves
// when the buyer has no aging loads left. Loads with no buyer recorded group
// under UNKNOWN_BUYER.
//
// Pure: no DB, no clock — rows + config + window in, findings out.

import type { AuditWindow, CheckConfig, Finding } from '../types';
import { makeFinder } from './helpers';

export const UNKNOWN_BUYER = '(no buyer recorded)';

export interface M3PaymentRow {
  loadId: string;
  buyer: string | null;
  shipDateISO: string;
  status: 'awaiting_invoice' | 'invoiced' | 'paid' | 'disputed';
  invoicedAtISO: string | null;
  ticketNumber: string | null;
}

export interface M3Input {
  /** ALL non-paid loads for the site (full history — payment aging outlives any sweep window). */
  rows: readonly M3PaymentRow[];
}

interface AgingItem {
  loadId: string;
  ticketNumber: string | null;
  shipDateISO: string;
  kind: 'uninvoiced' | 'unpaid';
  days: number;
}

function daysBetweenISO(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000,
  );
}

export function m3CommodityPaymentAging(
  window: AuditWindow,
  input: M3Input,
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  // A live run ages against asOf; a historical run has no "today" to age
  // against, so M3 only evaluates live runs (unlike per-day checks, aging is
  // a now-question).
  const asOfISO = window.asOfISO;
  if (!asOfISO) return [];

  const shipDays = Number(config.params['aging_ship_days'] ?? 30);
  const invoiceDays = Number(config.params['aging_invoice_days'] ?? 45);

  const byBuyer = new Map<string, AgingItem[]>();
  for (const row of input.rows) {
    if (row.status === 'paid' || row.status === 'disputed') continue;
    let item: AgingItem | null = null;
    if (row.status === 'awaiting_invoice') {
      const days = daysBetweenISO(row.shipDateISO, asOfISO);
      if (days > shipDays) {
        item = {
          loadId: row.loadId,
          ticketNumber: row.ticketNumber,
          shipDateISO: row.shipDateISO,
          kind: 'uninvoiced',
          days,
        };
      }
    } else if (row.status === 'invoiced' && row.invoicedAtISO) {
      const days = daysBetweenISO(row.invoicedAtISO, asOfISO);
      if (days > invoiceDays) {
        item = {
          loadId: row.loadId,
          ticketNumber: row.ticketNumber,
          shipDateISO: row.shipDateISO,
          kind: 'unpaid',
          days,
        };
      }
    }
    if (!item) continue;
    const buyer = row.buyer?.trim() || UNKNOWN_BUYER;
    const list = byBuyer.get(buyer) ?? [];
    list.push(item);
    byBuyer.set(buyer, list);
  }

  const finding = makeFinder('m3_commodity_payment_aging', window, config);
  const out: Finding[] = [];
  for (const [buyer, items] of [...byBuyer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.sort((a, b) => b.days - a.days);
    const uninvoiced = items.filter((i) => i.kind === 'uninvoiced').length;
    const unpaid = items.filter((i) => i.kind === 'unpaid').length;
    out.push(
      finding({
        kind: 'missing_counterpart',
        keys: [window.siteId, buyer],
        legARef: buyer,
        legBRef: null,
        expected: { uninvoicedWithinDays: shipDays, paidWithinDaysOfInvoice: invoiceDays },
        actual: { uninvoiced, unpaid },
        detail: {
          note: `commodity payment aging — ${buyer}: ${uninvoiced} load(s) uninvoiced past ${shipDays}d, ${unpaid} invoiced past ${invoiceDays}d unpaid`,
          buyer,
          loads: items.map((i) => ({
            loadId: i.loadId,
            ticket: i.ticketNumber,
            shipped: i.shipDateISO,
            kind: i.kind,
            days: i.days,
          })),
        },
      }),
    );
  }
  return out;
}
