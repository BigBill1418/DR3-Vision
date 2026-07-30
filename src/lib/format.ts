// Display formatting helpers, locale-aware. T-008 wired the user's
// stored locale through these.
//
// `formatRelative` returns translated strings via the operator
// dictionary's `relative_time.*` keys — the dictionary is small enough
// that we just import it directly here rather than threading a `t`
// callback into every caller. Server components pass `locale`; client
// components can use the same call (or `useT` directly for richer
// messages).

// ── ADR-0065 Amendment 1 (2026-07-30): these format true INSTANTS and MUST be
// pinned to Pacific ────────────────────────────────────────────────────────────
// `formatTime` / `formatDate` receive real points in time (`expected_arrival_at`,
// `arrived_at`, audit `created_at`), not @db.Date business days. They previously
// omitted `timeZone`, so `Intl` fell back to the RUNTIME default zone — and the
// app container has no `TZ` set. Measured inside `dr3-vision-app` on 2026-07-30:
//
//   Intl.DateTimeFormat().resolvedOptions().timeZone      -> "UTC"
//   format(2026-07-30T17:00:00Z)  without timeZone        -> "5:00 PM"
//   format(2026-07-30T17:00:00Z)  timeZone: Pacific       -> "10:00 AM"
//
// That instant is Woodland's real 10:00 AM docking appointment for 2026-07-30, and
// the floor queue was rendering it to the operator as "5:00 PM" — a 7-hour lie on
// the one field the dock screen exists to communicate ("which truck, when"). The
// most common MyMRC slot, 15:00Z, was showing as "3:00 PM" instead of 8:00 AM.
//
// Pacific is correct for EVERY caller: both facilities are Pacific (Woodland CA /
// Eugene OR) and so is Bill. This is the same zone `@/lib/time` already pins, and
// pinning it here rather than at each call site means a future caller cannot
// reintroduce the defect by forgetting an option. Use `pacificDateLabel` from
// `@/lib/time` for @db.Date business days instead — those must stay UTC-rendered
// (see the storage invariant at the top of that module).
import type { Locale } from '@/i18n/config';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { getDictionary, translate, translatePlural } from '@/i18n/dictionary';
import { PACIFIC_TZ } from '@/lib/time';

const TIME_FMT_CACHE = new Map<Locale, Intl.DateTimeFormat>();
const DATE_FMT_CACHE = new Map<Locale, Intl.DateTimeFormat>();

// `Intl.DateTimeFormat` constructor maps:
//   en -> en-US (12h, "Mon, May 6")
//   es -> es-MX (24h, "lun, 6 may")
//   ur -> ur-PK (12h Urdu numerals if user agent supports them)
const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-MX',
  ur: 'ur-PK',
};

function timeFmt(locale: Locale): Intl.DateTimeFormat {
  let f = TIME_FMT_CACHE.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: PACIFIC_TZ,
    });
    TIME_FMT_CACHE.set(locale, f);
  }
  return f;
}

function dateFmt(locale: Locale): Intl.DateTimeFormat {
  let f = DATE_FMT_CACHE.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: PACIFIC_TZ,
    });
    DATE_FMT_CACHE.set(locale, f);
  }
  return f;
}

export function formatTime(d: Date, locale: Locale = DEFAULT_LOCALE): string {
  return timeFmt(locale).format(d);
}

export function formatDate(d: Date, locale: Locale = DEFAULT_LOCALE): string {
  return dateFmt(locale).format(d);
}

export function formatRelative(
  from: Date,
  now: Date = new Date(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  const dict = getDictionary(locale);
  const ms = now.getTime() - from.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return s <= 1
      ? translate(dict, 'relative_time.just_now')
      : translate(dict, 'relative_time.sec_ago', { n: s });
  }
  const m = Math.round(s / 60);
  if (m < 60) return translate(dict, 'relative_time.min_ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return translate(dict, 'relative_time.hr_ago', { n: h });
  const d = Math.round(h / 24);
  return translatePlural(dict, 'relative_time.day_ago', d, { n: d });
}
