// MyMRC Playwright selectors. Per ADR-0009, this is the most fragile
// file in the codebase — when MRC redesigns the portal, this is the
// file that breaks. Treat changes with extra care.
//
// Verified against the MyMRC Salesforce Experience Cloud portal on:
//   - 2026-05-06 (initial T-015 ship)
//   - 2026-06-22 (Experience Cloud redesign — login form lost `name` attrs)
//   - 2026-07-03 (ADR-0038 discovery — confirmed login still valid; data feeds
//                 moved to Aura/JSON, so the old scheduled-hauls DOM selectors
//                 were retired. The list/detail transport now lives in
//                 `portal-client.ts` and never parses Lightning DOM.)
//
// When the portal changes:
//   1. Confirm via manual inspection.
//   2. Bump the SELECTOR_VERSION constant.
//   3. Update both the runbook (`docs/operator/mymrc-ingestion.md`) and this file.
//   4. Ship a CHANGELOG entry under "Selectors".

export const SELECTOR_VERSION = '2026-06-22';

export const SELECTORS = {
  /** MyMRC login form — username + password + submit (Lightning, no `name` attrs). */
  loginEmailField: 'input[placeholder="Username"]',
  loginPasswordField: 'input[type="password"]',
  loginSubmitButton: 'button:has-text("Log in")',
  /** Login redirect signal — Salesforce renders this field when unauthenticated. */
  loginRedirectMarker: 'input[placeholder="Username"]',
} satisfies Record<string, string>;

export type SelectorKey = keyof typeof SELECTORS;

/** Shared login URL — same for both sites; the credentials decide tenancy. */
export const LOGIN_URL = 'https://mrc-us.my.site.com/s/login/';
