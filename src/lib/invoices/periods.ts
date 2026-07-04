// ADR-0041 D2 — invoice billing windows (Pacific calendar dates).
//
// Pure date arithmetic over `@db.Date`-shaped keys: a billing month is its
// first-of-month `YYYY-MM-DD`. Two windows derive from it:
//   - EOM  = [1st .. last-day-of-month]   (whole month, inclusive)
//   - mid  = [1st .. 15th]                 (Rick Q2: 1st–15th INCLUSIVE
//            regardless of weekday — closes the open-register item)
// Both bounds are INCLUSIVE `YYYY-MM-DD` keys. The store invariant (src/lib/time.ts)
// is that a `@db.Date` value's UTC Y/M/D ARE the Pacific calendar day, so this
// module reasons purely in UTC calendar components — no zone shift, no clock.

import { dayISO, dayKeyUTCFromISO } from '@/lib/time';
import type { InvoiceKind } from './types';

export interface BillingWindow {
  startISO: string; // inclusive
  endISO: string; // inclusive
}

/** Normalize any `YYYY-MM-DD` to the first-of-its-month key. */
export function billingMonthStartISO(anyDayISO: string): string {
  const d = dayKeyUTCFromISO(anyDayISO);
  return dayISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
}

/** Last calendar day of the billing month (day 0 of next month = last of this). */
export function monthWindow(billingMonthISO: string): BillingWindow {
  const d = dayKeyUTCFromISO(billingMonthISO);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { startISO: dayISO(first), endISO: dayISO(last) };
}

/** 1st–15th inclusive (never weekday-adjusted — Rick Q2). */
export function midMonthWindow(billingMonthISO: string): BillingWindow {
  const d = dayKeyUTCFromISO(billingMonthISO);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const fifteenth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
  return { startISO: dayISO(first), endISO: dayISO(fifteenth) };
}

/**
 * The billing window for a kind. Mid-month kinds use the 1st–15th window; every
 * other kind uses the whole month. (OR has no mid-month kind by construction.)
 */
export function windowForKind(kind: InvoiceKind, billingMonthISO: string): BillingWindow {
  const monthISO = billingMonthStartISO(billingMonthISO);
  return kind === 'ca_processing_mid_month' ? midMonthWindow(monthISO) : monthWindow(monthISO);
}
