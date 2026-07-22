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
//   - 2026-07-22 (ADR-0057 Phase 0 FIRST LIVE RUN — the fixture-written login
//                 flow never matched the real form: the fields have NO `name`,
//                 DYNAMIC numeric ids (e.g. `173:0`/`186:0`), and are keyed only
//                 by PLACEHOLDER ("Username"/"Password"). The old
//                 `button:has-text("Log in")` also missed the real "Log In"
//                 caption. Login now fills by placeholder and clicks by role.
//                 Authenticated landing is `/s/` (title "Home", "Switch Account"
//                 banner); `/s/home` is a 404 error page for EVERYONE.)
//
// When the portal changes:
//   1. Confirm via manual inspection.
//   2. Bump the SELECTOR_VERSION constant.
//   3. Update both the runbook (`docs/operator/mymrc-ingestion.md`) and this file.
//   4. Ship a CHANGELOG entry under "Selectors".

export const SELECTOR_VERSION = '2026-07-22';

export const SELECTORS = {
  /**
   * MyMRC login form — username + password + submit. The Lightning form has NO
   * `name` attrs and DYNAMIC numeric ids, so the ONLY stable hook is the
   * PLACEHOLDER text (case-insensitive; the live form pads with trailing
   * whitespace on some renders). The transport fills by placeholder / clicks by
   * role (see `portal-client.login`); these CSS forms are the marker/fallback.
   */
  loginEmailField: 'input[type="text"][placeholder="Username" i], input[placeholder="Username" i]',
  loginPasswordField: 'input[type="password"][placeholder="Password" i], input[type="password"]',
  loginSubmitButton: 'button:has-text("Log In"), button:has-text("Log in")',
  /** Login redirect signal — Salesforce renders these when unauthenticated. */
  loginRedirectMarker: 'input[placeholder="Username" i], input[type="password"]',
} satisfies Record<string, string>;

export type SelectorKey = keyof typeof SELECTORS;

/** Portal origin (both DR3 recyclers share it; the account context decides tenancy). */
export const PORTAL_ORIGIN = 'https://mrc-us.my.site.com';

/** Shared login URL — same for both sites; the credentials decide tenancy. */
export const LOGIN_URL = `${PORTAL_ORIGIN}/s/login/`;

/**
 * Authenticated landing page. Renders title "Home" + the "Good morning, …
 * You're currently viewing as DR3 <site>. Switch Account" banner + the object
 * nav. This is the auth-verification target — NOT `/s/home`, which is a 404
 * "Error" page for authenticated AND anonymous sessions alike (the old
 * discovery runner enumerated against it and got zero objects).
 */
export const AUTHED_HOME_URL = `${PORTAL_ORIGIN}/s/`;

/**
 * Nav slugs (the `/s/<slug>` path segment) that are OBJECT LIST pages we
 * enumerate. Captured from the authenticated nav 2026-07-22. Each is a
 * ListView page whose `getItems` Aura action yields the object's record ids.
 * `illegal-dump-cip-` keeps its live (trailing-dash) slug verbatim.
 */
export const OBJECT_NAV_SLUGS: readonly string[] = [
  'hauls',
  'processed-materials',
  'outbound-materials',
  'illegal-dump-cip-',
  'availability',
  'outbound-vendors',
  'records-review',
] as const;
