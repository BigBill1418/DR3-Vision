// DR3-Vision i18n — dictionary type + interpolation helper.
//
// Architecture choice (T-008): we ship a leaner home-grown loader
// instead of pulling `next-i18n-router` / `i18next-resources-to-backend`
// into the runtime. Rationale:
//
//   - The operator surface is small (~one page tree) — i18next's
//     `Trans` + suspense backend is overkill.
//   - Server-component rendering wants a SYNCHRONOUS dictionary import
//     so we don't add a `await initI18n()` at every server-component
//     entry. With 3 small locale JSONs we can `import en from
//     './locales/en/operator.json' assert { type: 'json' }` and the
//     bundler tree-shakes the unused languages off the server bundle.
//   - Client subtrees receive the dictionary as a prop from the
//     server — no client-side fetch, no flash of untranslated content,
//     no need for i18next's detection layer.
//
// `i18next` is still in package.json (kept from T-001) but unused at
// runtime. If a future ticket needs i18next features (pluralization
// CLDR rules, ICU MessageFormat, etc.) it can wire i18next on top of
// the same JSON files without rearranging this layer.

import type { Locale } from './config';
import enOperator from './locales/en/operator.json';
import esOperator from './locales/es/operator.json';
import urOperator from './locales/ur/operator.json';
import enManager from './locales/en/manager.json';
import esManager from './locales/es/manager.json';
import urManager from './locales/ur/manager.json';

// The English JSON is the canonical shape. Spanish + Urdu must carry the
// SAME keys.
//
// `Widen<T>` recursively replaces literal value types (each string's own
// literal, e.g. `"Confirm"`) with their base type (`string`). Without it,
// `typeof enOperator` types every value as its exact English literal, so a
// perfectly-parity Spanish file — same keys, translated values — would fail
// assignment purely because `"Confirmar" !== "Confirm"`. That literal
// mismatch is precisely why the old code reached for `as Dictionary`, and
// that cast silently ALSO suppressed the real check (a MISSING key). Widening
// the values restores a genuine compile-time guarantee: es/ur are assigned to
// `Record<Locale, Dictionary>` WITHOUT a cast, so a key present in `en` but
// missing in es/ur is now a hard `tsc` error again (ADR-0061 D-5).
//
// Compile-time checking cannot cover EXTRA keys (excess-property checks don't
// apply to non-literal assignment — the inert `_meta._comment*` notes are
// harmless extras) nor empty-string drift. The CI-blocking parity test
// (`locale-parity.test.ts`) is the real, bidirectional guard; this type is
// the fast local backstop.
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : { [K in keyof T]: Widen<T[K]> };

export type Dictionary = Widen<typeof enOperator>;
export type ManagerDictionary = Widen<typeof enManager>;

const DICTIONARIES: Record<Locale, Dictionary> = {
  en: enOperator,
  es: esOperator,
  ur: urOperator,
};

const MANAGER_DICTIONARIES: Record<Locale, ManagerDictionary> = {
  en: enManager,
  es: esManager,
  ur: urManager,
};

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

// Manager-portal dictionary. Lives in its own namespace so the dashboard
// surface can iterate without churning the iPad strings (and the
// reverse). Kept synchronously imported so server components stay
// `await`-free at the entry point.
export function getManagerDictionary(locale: Locale): ManagerDictionary {
  return MANAGER_DICTIONARIES[locale];
}

// ────────────────────────────────────────────────────────────────────
// Translation lookup
// ────────────────────────────────────────────────────────────────────

// Dot-path resolution. A miss returns the key itself (visible in dev,
// preferable to throwing in prod where a missing translation should
// degrade rather than crash the page).
//
// `dict` widened to `unknown` since the same machinery serves both
// the operator + manager namespaces (different shapes, same algorithm).
function resolvePath(dict: unknown, key: string): string {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  return typeof cur === 'string' ? cur : key;
}

export type TranslateVars = Record<string, string | number>;

// Mustache-style {{var}} interpolation. Numbers are passed through
// String() — locale-aware number formatting is the caller's job
// (e.g. `format.ts:formatNumber(locale, n)`).
export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    return v == null ? `{{${name}}}` : String(v);
  });
}

// ICU-light pluralization: chooses `<key>_one` for n=1, `<key>_other`
// otherwise. Falls back to the bare key if neither variant exists.
// Sufficient for the 5–6 English plural messages in the operator
// surface; richer CLDR rules (Polish/Russian few/many) would warrant
// pulling i18next back in.
export function translatePlural(
  dict: Dictionary | ManagerDictionary,
  baseKey: string,
  count: number,
  vars?: TranslateVars,
): string {
  const variant = count === 1 ? `${baseKey}_one` : `${baseKey}_other`;
  const merged = { count, ...(vars ?? {}) };
  const resolved = resolvePath(dict, variant);
  if (resolved !== variant) return interpolate(resolved, merged);
  // Fallback to base key if no variants exist.
  const base = resolvePath(dict, baseKey);
  return interpolate(base, merged);
}

export function translate(
  dict: Dictionary | ManagerDictionary,
  key: string,
  vars?: TranslateVars,
): string {
  return interpolate(resolvePath(dict, key), vars);
}
