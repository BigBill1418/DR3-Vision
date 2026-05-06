# ADR-0015: i18n architecture — server dictionaries + client React Context

**Date:** 2026-05-06
**Status:** Accepted
**Supplements:** none
**Implements:** CLAUDE.md hard rule #4, SPRINT-1-PLAN T-008

## Context

CLAUDE.md hard rule #4 mandates English / Spanish / Urdu (RTL) on day 1.
T-008 ships that capability across the operator surface. The Sprint
plan called for `i18next` + `next-i18n-router` + the
`i18next-resources-to-backend` HTTP loader (all already in
`package.json` from T-001). Working through the operator surface, two
things became clear:

1. The operator string surface is small — ~120 keys, ~3 KB gzipped per
   locale. The full i18next stack (~30 KB gzipped client-side, plus
   suspense fallback wiring) is overkill.
2. Next.js 15's App Router prefers SYNCHRONOUS server-side
   translation lookups. Bolting `i18next-resources-to-backend` (which
   is fundamentally async) onto every server component adds an
   `await initI18n()` line at every entry — friction that's hard to
   keep consistent without a route group helper.

`next-i18n-router` itself is a `[locale]`-segment router. Adopting it
would force every route under `/operator/[locale]/*`, which is a 30+
file rename on top of T-008 and changes the URL contract every other
ticket already depends on. Not worth it for this surface size.

## Decision

### 1. Server-side: synchronous JSON imports

Translation files at `src/i18n/locales/{en,es,ur}/operator.json` are
imported directly by `src/i18n/dictionary.ts`. The English JSON is the
canonical shape; Spanish + Urdu inherit it via `as Dictionary` casts
that the typecheck enforces. Server components call:

```ts
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';

const locale = await getLocale();
const dict = getDictionary(locale);
const t = (k: string, vars?: Record<string, string | number>) =>
  translate(dict, k, vars);
```

`translate()` does dot-path lookup + Mustache-style `{{var}}`
interpolation. `translatePlural()` adds a `_one` / `_other` suffix
chooser for the handful of singular/plural messages on the surface.
Missing keys return the key itself — visible in dev, degraded
(not crashed) in prod.

### 2. Client-side: React Context provider

Route groups (`/operator`, `/login`) get a layout that resolves the
locale once and wires `<I18nProvider locale={...} dict={...}>`. The
provider exposes `useT()`, `useTPlural()`, and `useLocale()` hooks.
The dictionary travels through the RSC payload, so client components
hydrate with translations already in memory — no flash of untranslated
content.

### 3. Locale precedence

`?lang=` query > `dr3_locale` cookie > `users.locale` from session >
`'en'` default. The cookie wins over session because the locale picker
on `/login` writes the cookie BEFORE the user has a session; on
successful credentials/PIN auth, `auth.ts` mirrors cookie →
`users.locale` so the next sign-in on a different device respects the
preference.

### 4. RTL handling

`<html dir>` is set in the root layout from `dirFor(locale)` — `'rtl'`
for Urdu, `'ltr'` for everything else. Tailwind's logical-property
utilities (`ms-`/`me-`/`ps-`/`pe-`/`text-start`/`text-end`) handle
most layout flips automatically. Three call-out exceptions are forced
`dir="ltr"` regardless of page locale:

- The PIN keypad — digits stay 1-2-3 / 4-5-6 / 7-8-9 / ⌫-0
- The unload timer's `mm:ss` digits
- The PhotoInput's filename caption

Numerals are universally LTR; flipping them would surprise the operator.

### 5. Date / time formatting

`src/lib/format.ts` `formatTime` / `formatDate` / `formatRelative`
take an optional `locale: Locale` param (default `en`). Maps:
`en → en-US`, `es → es-MX`, `ur → ur-PK`. `Intl.DateTimeFormat`
instances cached per-locale.

### 6. Voice-to-text

Per SPRINT-1-PLAN T-008: "native iPadOS dictation; correctness is
iPadOS's job, not ours". The two textareas (`stage-finish`,
`stage-reject`) carry `lang={locale}` so iPadOS's keyboard dictation
selects the right input language model. No custom recognition wired.

## Alternatives considered

- **Full i18next stack** — rejected per the size argument above.
  `i18next` stays in `package.json` and could be wired on top of the
  same JSON files if a future ticket needs CLDR plural rules or ICU
  MessageFormat. Until then, the lighter homegrown layer ships.
- **`next-i18n-router` `[locale]` segment** — rejected per the route
  rename argument above. The fleet's URL contract (
  `/operator/{eugene,woodland}/{userId}/...`) is depended on by the
  iPad cookie pinning + the manager portal's deep links.
- **Client-side `i18next` init from a `<script>` tag** — rejected
  because it produces a flash of untranslated content on iPad (the
  fleet's slowest hardware target) and the JSON-on-RSC path avoids it.
- **One JSON namespace per stage** — rejected as premature
  optimization. The whole operator dictionary is ~3 KB / locale; the
  server bundle inlines the active locale only.

## Consequences

- Manager portal i18n is **not** delivered by T-008 — flagged as a
  follow-up. The infrastructure is in place; a future ticket adds
  `dashboard/layout.tsx` + a `manager.json` namespace alongside
  `operator.json`.
- Date/time/relative-time format helpers now take an optional locale
  argument. Callers in `dashboard/*` that don't pass one default to
  English; their strings will localize when manager-portal i18n
  ships.
- Auth-mirror writes `users.locale` on successful credentials AND PIN
  authentication. Failures are non-fatal (locale is UX, not security).
- `i18next` family packages (`i18next`, `i18next-browser-languagedetector`,
  `i18next-resources-to-backend`, `next-i18n-router`) remain in
  `package.json` even though unused at runtime. Removing them is a
  separate cleanup ticket; keeping them costs ~200 KB on `node_modules`
  but zero on the production bundle (no imports = tree-shaken).

## References

- `src/i18n/config.ts` — locale registry, RTL detector, cookie name
- `src/i18n/dictionary.ts` — server-side translate + plural
- `src/i18n/get-locale.ts` — server-side locale resolver
- `src/i18n/provider.tsx` — `<I18nProvider>` + `useT()` / `useTPlural()`
- `src/i18n/actions.ts` — `setLocaleAction()` server action
- `src/i18n/locales/{en,es,ur}/operator.json` — translations
- `src/lib/format.ts` — locale-aware date/time/relative
- `src/app/operator/layout.tsx` — operator route-group provider wiring
- `src/app/login/layout.tsx` — login page provider wiring
- `src/app/login/locale-picker.tsx` — three-button picker
- `src/lib/auth.ts` — cookie → `users.locale` mirror
- ADR-0014 — auth surfaces dark, operator surfaces green (unchanged)
