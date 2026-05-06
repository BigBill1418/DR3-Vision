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
export const LOCALE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

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
