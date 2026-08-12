// Audit D-4 — the guard over the map, not over the cases someone remembered.
//
// Three divergent copies of the floor status map were live at `origin/main`
// a10b887d (see `floor-status-label.ts`). `held-by-panel.test.tsx` already
// walked the enum for ITS copy, which is exactly why that copy was complete and
// the other two were not: the guard was attached to a file rather than to the
// concept. It now sits on the shared module, so it covers every surface that
// reads it.
//
// Two independent things are asserted, and both matter:
//
//   1. Every `LoadStatus` in the SCHEMA has an entry. This is what catches a
//      status added to `prisma/schema.prisma` — the way `voided` arrived under
//      ADR-0090 C — without anyone deciding what the floor should call it.
//   2. Every key the map names EXISTS IN ALL THREE CATALOGUES. A complete map
//      pointing at a missing key renders the raw key path at an operator, which
//      is the same defect one layer down. `locale-parity.test.ts` proves the
//      three locales agree with each other; it cannot prove this file's keys are
//      among them.

import { describe, expect, it } from 'vitest';
import { LoadStatus } from '@prisma/client';
import en from '@/i18n/locales/en/operator.json';
import es from '@/i18n/locales/es/operator.json';
import ur from '@/i18n/locales/ur/operator.json';
import {
  FLOOR_STATUS_KEY,
  FLOOR_STATUS_FALLBACK_KEY,
  floorStatusKey,
} from './floor-status-label';

const CATALOGUES = { en, es, ur } as const;

/** Resolve a dot-path against a catalogue without `any`. */
function lookup(cat: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
      cat,
    );
}

describe('the floor status map covers the whole enum', () => {
  it.each(Object.values(LoadStatus))('`%s` has a label key', (status) => {
    expect(
      FLOOR_STATUS_KEY[status],
      `LoadStatus "${status}" has no FLOOR_STATUS_KEY entry — the floor would call it "Status unknown"`,
    ).toBeTruthy();
  });

  it('carries no entry for a status the schema does not define', () => {
    // The inverse direction. A stale entry is harmless to render but it is a
    // claim the schema no longer supports, and it is how a map drifts into
    // describing a state that cannot occur.
    const schema = new Set<string>(Object.values(LoadStatus));
    expect(Object.keys(FLOOR_STATUS_KEY).filter((k) => !schema.has(k))).toEqual([]);
  });
});

describe('the fallback admits ignorance rather than guessing', () => {
  it('an unknown status resolves to "status unknown", never to a live stage', () => {
    expect(floorStatusKey('some_future_status')).toBe(FLOOR_STATUS_FALLBACK_KEY);
  });

  it('THE DEFECT: the fallback is not the in-progress label', () => {
    // `open-loads.tsx` fell back to `queue.open_status_in_progress` — "Counting"
    // — so a closed load reaching it was described to the operator as being
    // counted right now. That is the confident-wrong-answer ADR-0074 Am.1 fixed
    // in `held-by-panel.tsx` and this test is what stops it being reintroduced
    // by the next author who wants a "friendlier" default.
    expect(FLOOR_STATUS_FALLBACK_KEY).not.toBe('queue.open_status_in_progress');
    expect(lookup(en, FLOOR_STATUS_FALLBACK_KEY)).toBe(en.queue.open_status_unknown);
  });
});

describe('every key the map names is translated in all three locales', () => {
  const keys = [...Object.values(FLOOR_STATUS_KEY), FLOOR_STATUS_FALLBACK_KEY];

  it.each(keys)('`%s` resolves in en, es and ur', (key) => {
    for (const [locale, cat] of Object.entries(CATALOGUES)) {
      const value = lookup(cat, key);
      expect(typeof value, `${key} is missing from the ${locale} catalogue`).toBe('string');
      expect(String(value).trim(), `${key} is empty in the ${locale} catalogue`).not.toBe('');
    }
  });
});
