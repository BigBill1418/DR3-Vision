# ADR-0061 — iPad / floor surface i18n parity with the Vision main portal

**Date:** 2026-07-25
**Status:** Accepted (2026-07-25)
**Supersedes / relates to:** ADR-0060 (iPad floor inventory-validation surfaces),
T-008 (i18n foundation), ADR-0017 (/admin English-only).
**Build plan:** `docs/plans/2026-07-25-ipad-i18n-parity.md`

## Context

Bill's requirement, verbatim: _"make sure that all of the iPad surfaces are available in the
same languages that the Vision main portal is. this is critical."_

The DR3-Vision i18n layer (T-008) ships English, Spanish, and Urdu (RTL) via a home-grown
synchronous dictionary loader (`src/i18n/`), not next-intl/next-i18n-router at runtime. The
canonical locale set is fixed in `src/i18n/config.ts`: `LOCALES = ['en','es','ur']`, default
`en`, cookie `dr3_locale`, RTL = `{ur}`. Both the manager desktop portal
(`dashboard/layout.tsx`) and the operator iPad shell (`operator/layout.tsx`) consume the same
`LOCALES` through the same `I18nProvider`, so the language set is identical by construction;
`users.locale` mirrors the Prisma `UserLocale` enum.

An audit of every operator route against Bill's requirement found:

- **Translations already exist and are in parity.** All 222 real `operator` keys and all 176 real
  `manager` keys are present in en/es/ur (the only cross-locale diffs are inert
  `_meta._comment*` translator notes). Every operator surface — the sign-in trio, `/today`,
  `/inbound`, `/count`, `/processed`, `/queue`, and `/load/[id]` with all eight stages — routes
  its copy through `useT()`/`translate()`. A hardcoded-string scan found zero user-visible English
  literals. RTL is mature: root `<html dir>`, with `dir="ltr"` islands protecting the keypad and
  numeric spans.
- **But a Spanish/Urdu floor operator cannot reach their language.** Five defects:
  - **D-1** The locale switcher (`login/locale-picker.tsx`) is mounted only at `/login`. Floor
    operators sign in by PIN and never touch `/login`; the `/operator` route group has no language
    control at all. Managers (Entra via `/login`) can switch; floor staff cannot.
  - **D-2** The pre-auth sign-in screens (`/operator`, name-picker, keypad) resolve locale with no
    session and no cookie, so they hard-fall to `en`. The operator must read English to sign in.
  - **D-3** `users.locale` is only ever written by the `/login` picker or by `mirrorLocaleCookie`
    (which needs a cookie floor staff don't have); there is no admin editor. So a floor operator's
    stored locale stays `en` forever and even post-auth surfaces render English.
  - **D-4** The `dr3_locale` cookie is device-global, 1-year, and takes precedence over the
    signed-in operator's `users.locale`; `mirrorLocaleCookie` also overwrites `users.locale` with
    it. On a shared iPad one manager's pick pins and corrupts the whole shift's language.
  - **D-5** `dictionary.ts` uses `as Dictionary` assertions that defeat the claimed compile-time
    parity check, so future key drift is silent — a missing es/ur key renders the raw dot-path to
    the operator, including on money/UX-safe actions (Confirm/Correct/Save, program vs non-program).

Net: the iPad ships the same language set as the portal and is fully translated, but the
capability is unreachable for the floor. The honest answer to Bill's question today is "the
translations are available; the operator's access to them is not."

## Decision

Make the existing en/es/ur translations **reachable, per-operator, and shared-device-safe** on
the floor, and **enforce parity in CI** so "same languages" cannot silently rot — without touching
auth/login logic (the PIN-login bounce fix is owned separately).

1. **Floor locale switcher (D-1/D-2).** Add an operator-namespace switcher rendering the three
   `LOCALE_LABELS` (each in its own script, ≥44px targets), mounted in `operator/layout.tsx` so it
   is present on every operator screen including the pre-auth sign-in trio and mid-shift.
2. **Session-first resolution (D-4).** Change `getLocale`/`resolveLocale` precedence to
   `?lang=` > session `users.locale` (when signed in) > `dr3_locale` cookie (pre-auth only) > `en`.
   The signed-in operator's language always wins over the device cookie.
3. **Persist per operator (D-3).** A new `setFloorLocaleAction` writes `users.locale` when a
   session exists, and otherwise sets a short-lived pre-auth cookie so the sign-in screens localize
   immediately; PIN auth's existing `mirrorLocaleCookie` folds that into `users.locale`. Optionally
   expose `locale` in the `admin/users/[id]` editor so managers can pre-set it.
4. **Parity enforcement (D-5).** Add a CI-blocking key-parity test across all `locales/*/*.json`
   (ignoring `_meta.*`) and remove/replace the false `as Dictionary` assertions. This — not the
   type assertion — is the mechanism that guarantees every current and future surface stays in the
   full locale set.

RTL numerals policy is affirmed: operational numerics (counts, weights, PINs, stepper values) stay
Western/LTR; only `Intl`-formatted dates/times may localize numerals.

## Options considered

- **A — Do nothing / rely on the existing `/login` picker.** Rejected: floor operators never reach
  `/login`; this is the entire defect.
- **B — Force the whole iPad device to one language via a per-device config.** Rejected: a shared
  iPad serves operators of different languages across a shift; language must follow the person, not
  the device (this is also the D-4 failure being removed).
- **C — Per-operator selection + session-first resolution + CI parity guard (CHOSEN).** Language
  follows the signed-in operator, the sign-in screens are selectable, and parity is enforced
  mechanically. Highest correctness, no auth-logic change, shared-device-safe.
- **D — Only add missing translation keys.** Rejected as insufficient: there are no missing keys;
  the gap is reachability, not content.

## Consequences

- A Spanish- or Urdu-reading floor operator can select their language on the sign-in screens, and
  it persists to them across devices; every iPad surface then renders end-to-end in that language
  with correct RTL — the direct satisfaction of Bill's requirement.
- Shared iPads no longer pin or corrupt a shift's language; the cookie becomes a pre-auth hint only.
- CI now fails if any locale file drifts from `en`, so new surfaces cannot ship English-only to
  es/ur by omission.
- Small surface-area change to `getLocale` precedence; must be covered by the precedence unit test
  to avoid regressing the `/login` picker's pre-auth behavior.
- No change to auth/PIN logic; `mirrorLocaleCookie` is retained.

## Verification

- Key-parity unit test (CI-blocking), resolution-precedence unit test (incl. shared-iPad case),
  and an iPad-viewport Playwright matrix (9 surfaces × 3 locales, portrait+landscape) reviewed BY
  EYE — sign-in screens localize pre-auth, post-auth follows the operator, Urdu is RTL with LTR
  numerals and no raw dot-path keys on critical actions. Confirm on the live public DR3 URL at an
  iPad viewport after deploy; verify the running container, not just git HEAD (DR3 build-races-pull).

## Notes

Design docs and code must be authored in a git worktree, never the DR3-Vision main checkout —
docs written into the main checkout have repeatedly jammed the deployer's dirty-tree guard.
