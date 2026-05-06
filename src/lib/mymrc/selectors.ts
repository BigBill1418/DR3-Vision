// MyMRC Playwright selectors. Per ADR-0009, this is the most fragile
// file in the codebase — when MRC redesigns the portal, this is the
// file that breaks. Treat changes with extra care.
//
// Verified against the MyMRC Salesforce Experience Cloud portal on:
//   - 2026-05-06 (initial T-015 ship)
//
// When the portal changes:
//   1. Confirm via manual inspection.
//   2. Bump the SELECTOR_VERSION constant.
//   3. Update both the runbook (`docs/MYMRC-INTEGRATION.md`) and this file.
//   4. Ship a CHANGELOG entry under "Selectors".

import type { SiteCode } from './types';

export const SELECTOR_VERSION = '2026-05-06';

export const SELECTORS = {
  /** MyMRC login form — email + password + submit. */
  loginEmailField: 'input[name="username"]',
  loginPasswordField: 'input[name="password"]',
  loginSubmitButton: 'button[type="submit"]',
  /** Post-login signal: any chrome that only renders for an authenticated session. */
  authedShellMarker: 'nav[aria-label="recycler-portal"], a[href*="/scheduled-hauls"]',
  /** Login redirect signal — Salesforce redirects unauthenticated requests here. */
  loginRedirectMarker: 'input[name="username"]',

  /** Scheduled-hauls table on the per-site landing. */
  scheduledHaulsTable: 'table[data-purpose="scheduled-hauls"]',
  /** Fallback selector for legacy table markup (no data-purpose attribute). */
  scheduledHaulsTableFallback: 'table.scheduled-hauls',
  /** "No upcoming hauls" empty-state marker. */
  scheduledHaulsEmptyState: '[data-purpose="scheduled-hauls-empty"]',
} satisfies Record<string, string>;

export type SelectorKey = keyof typeof SELECTORS;

/**
 * Per-site MyMRC URL builder. The `recycler` query parameter is what
 * scopes the page to one MRC account; we always pass the long form
 * matching the Recycler column in the haul export.
 */
export function scheduledHaulsUrl(site: SiteCode): string {
  const recycler = site === 'eugene' ? 'DR3 Eugene' : 'DR3 Woodland';
  return `https://mrc-us.my.site.com/s/scheduled-hauls?recycler=${encodeURIComponent(recycler)}`;
}

/** Shared login URL — same for both sites; the credentials decide tenancy. */
export const LOGIN_URL = 'https://mrc-us.my.site.com/s/login/';
