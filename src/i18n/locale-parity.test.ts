/**
 * CI-BLOCKING locale key-parity guard (ADR-0061 D-5).
 *
 * This is the real mechanism that keeps "the iPad ships the same languages as
 * the main portal" TRUE for every current and future surface. The compile-time
 * `Widen<>` check in `dictionary.ts` catches a key that exists in `en` but is
 * missing from es/ur; this test is the bidirectional, value-aware backstop:
 *
 *   - every locale carries the EXACT same leaf-key set as `en` (no missing,
 *     no extra) in BOTH namespaces, and
 *   - no translated value is an empty / whitespace-only string.
 *
 * Inert translator-note keys (`_meta.*`) are intentionally excluded — they are
 * the only legitimate cross-locale difference. Delete a real key from any
 * locale file and this test goes red before the change can merge.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './config';

const NAMESPACES = ['operator', 'manager'] as const;
const REFERENCE_LOCALE = 'en';

type Json = Record<string, unknown>;

function loadNamespace(locale: string, ns: string): Json {
  const url = new URL(`./locales/${locale}/${ns}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Json;
}

// Flatten to a set of dot-path leaf keys. Any node named `_meta` (translator
// notes) is skipped at whatever depth it appears.
function leafKeys(obj: Json, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_meta') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...leafKeys(v as Json, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function emptyValuePaths(obj: Json, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_meta') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...emptyValuePaths(v as Json, path));
    } else if (typeof v === 'string' && v.trim() === '') {
      out.push(path);
    }
  }
  return out;
}

describe('locale key parity (ADR-0061 D-5)', () => {
  for (const ns of NAMESPACES) {
    const reference = new Set(leafKeys(loadNamespace(REFERENCE_LOCALE, ns)));

    for (const locale of LOCALES) {
      if (locale === REFERENCE_LOCALE) continue;

      it(`${locale}/${ns}.json has the exact same keys as ${REFERENCE_LOCALE}/${ns}.json`, () => {
        const keys = new Set(leafKeys(loadNamespace(locale, ns)));

        const missing = [...reference].filter((k) => !keys.has(k)).sort();
        const extra = [...keys].filter((k) => !reference.has(k)).sort();

        // Reported together so a drift shows both sides at once.
        expect(
          { missing, extra },
          `${locale}/${ns} drifted from ${REFERENCE_LOCALE}/${ns}`,
        ).toEqual({ missing: [], extra: [] });
      });

      it(`${locale}/${ns}.json has no empty translations`, () => {
        expect(emptyValuePaths(loadNamespace(locale, ns))).toEqual([]);
      });
    }
  }
});
