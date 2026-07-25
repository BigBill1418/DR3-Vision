// DR3-Vision i18n — locale registry + cookie name.
//
// T-008 ships English / Spanish / Urdu (RTL) on day 1 per CLAUDE.md
// hard rule #4. The Locale type mirrors the prisma `UserLocale` enum
// (`en` | `es` | `ur`) — we share the literal codes so a session's
// stored locale flows straight through without translation.
//
// `LOCALE_COOKIE` is the read/write key for the unauthenticated locale
// preference (set on /login, sticks across reloads). Once the operator
// has signed in, the next render prefers `users.locale` from the
// session over the cookie — see `getLocale()`.

export const LOCALES = ['en', 'es', 'ur'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'dr3_locale';
// 1 year — long enough to survive an iPad in storage between shifts.
// Used by the /login (manager) picker. On a shared floor iPad this cookie
// is only a PRE-AUTH display hint now (ADR-0061 D-4 made resolution
// session-first), so its length is no longer able to pin an authenticated
// operator's language.
export const LOCALE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

// Floor (operator) picks use a SHORT-lived display-hint cookie — one shift,
// not a year — so a shared kiosk does not carry one operator's pre-auth
// language onto the next operator's sign-in screens (ADR-0061 D-4). The
// authoritative preference is `users.locale`, resolved session-first.
export const LOCALE_COOKIE_SHIFT_MAX_AGE_S = 60 * 60 * 12;

// Explicit-pick marker (ADR-0061 D-4). Set ONLY on a pre-auth locale pick
// (no session yet); its presence tells `mirrorLocaleCookie` that the
// operator DELIBERATELY chose a language during this sign-in flow, so that
// choice may be folded into `users.locale` on authentication. An ambient
// device `dr3_locale` cookie with NO marker is never folded — that is the
// mechanism that stops a shared iPad from overwriting an operator's stored
// preference. Short TTL bounds the abandoned-pick window; httpOnly since no
// client code reads it.
export const LOCALE_PICK_COOKIE = 'dr3_locale_pick';
// 15 min — long enough to complete a PIN sign-in, short enough that an
// abandoned pick cannot linger onto an unrelated later operator.
export const LOCALE_PICK_COOKIE_MAX_AGE_S = 60 * 15;

// RTL languages. Urdu is the only one in scope; future Arabic / Hebrew
// would extend this set without touching consumers.
const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ur']);

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

export function dirFor(locale: Locale): 'ltr' | 'rtl' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

// Display labels for the picker. These are intentionally written in
// the target language so a non-English-speaking operator can still pick
// theirs unaided.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  ur: 'اردو',
};
