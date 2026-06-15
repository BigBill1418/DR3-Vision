// @vitest-environment jsdom
//
// Regression guard for the 2026-06-15 "fields don't autopopulate when I pick a
// different day" bug. `DailyEntryGrid` seeds its input state from `rows` in the
// `useState` initializer, which runs ONCE per mount. On client-side date
// navigation the page passes new `rows` but React reuses the instance, so the
// seed never re-runs and inputs show the previous day's data. The fix is a
// `key={entryDate}` on the grid in `page.tsx` (it remounts → re-seeds). These
// tests pin both halves of that contract:
//   1. a fresh mount seeds inputs from `rows` (so re-keying shows the new day);
//   2. re-rendering the SAME instance with new `rows` does NOT update inputs
//      (documents WHY the page-level `key` is required — don't "optimize" it
//      away without a replacement sync).

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DailyEntryGrid, type GridRowProps } from './DailyEntryGrid';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rule = { threshold_low: 50, rate_low: 0.5, threshold_high: 75, rate_high: 0.25 };

const EMP = 'emp-aamir';
const rowsWith = (count: number | null): GridRowProps[] => [
  { bonus_employee_id: EMP, full_name: 'Aamir Mehmood', mattress_count: count, note: null },
];

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

function countInput(): HTMLInputElement {
  return container.querySelector(`[data-testid="grid-count-${EMP}"]`) as HTMLInputElement;
}

describe('DailyEntryGrid date seeding', () => {
  it('seeds the count input from rows on mount (a populated day)', () => {
    mount(
      <DailyEntryGrid
        rule={rule}
        entryDate="2026-06-12"
        editable
        monthState="draft"
        rows={rowsWith(94)}
      />,
    );
    expect(countInput().value).toBe('94');
  });

  it('a fresh mount with no entry shows an empty input (remount = re-seed, what the page key triggers)', () => {
    mount(
      <DailyEntryGrid
        rule={rule}
        entryDate="2026-06-13"
        editable
        monthState="draft"
        rows={rowsWith(null)}
      />,
    );
    expect(countInput().value).toBe('');
  });

  it('re-rendering the SAME instance with new rows does NOT update the input — proves the page-level key is required', () => {
    mount(
      <DailyEntryGrid
        rule={rule}
        entryDate="2026-06-12"
        editable
        monthState="draft"
        rows={rowsWith(94)}
      />,
    );
    expect(countInput().value).toBe('94');
    // Simulate the buggy path: same instance (no key change), new day's rows.
    act(() =>
      root.render(
        <DailyEntryGrid
          rule={rule}
          entryDate="2026-06-12"
          editable
          monthState="draft"
          rows={rowsWith(null)}
        />,
      ),
    );
    // Stale on purpose — this is exactly why page.tsx keys the grid by date.
    expect(countInput().value).toBe('94');
  });
});
