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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ── ADR-0028 amendment-modal wiring ─────────────────────────────
//
// A non-admin manager editing a PRIOR day's count cannot write directly: the
// POST returns 409 `requires_amendment`. Instead of dumping the raw error
// string, the grid must pivot to the RequestEditModal, mapping the response's
// `pending[]` + `approverName` onto the modal payload and pulling the employee
// display name from its own rows. Multiple pending changes queue one at a time.

// Set an <input> value the React-controlled way (native setter + input event),
// so the component's onChange fires and state updates. Wrapped in act() so the
// resulting state flush is captured (no "not wrapped in act(...)" warning).
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickSave() {
  const btn = container.querySelector('[data-testid="grid-save"]') as HTMLButtonElement;
  act(() => btn.click());
}

async function flush() {
  // Let the awaited fetch().then(...) microtasks settle inside act().
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DailyEntryGrid — ADR-0028 amendment modal wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('a 409 requires_amendment response opens the modal with the mapped payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'requires_amendment',
              monthId: 'period-123',
              approverName: 'Morena Ruiz',
              pending: [
                {
                  bonus_employee_id: EMP,
                  change_type: 'update',
                  existing: { mattress_count: 40, note: null },
                  proposed: { mattress_count: 55, note: null },
                },
              ],
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    mount(
      <DailyEntryGrid
        rule={rule}
        entryDate="2026-06-12"
        editable
        monthState="draft"
        rows={rowsWith(40)}
      />,
    );

    // Manager changes the prior-day count, then saves.
    setInputValue(countInput(), '55');
    clickSave();
    await flush();

    // The modal is open (not the raw error string).
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const text = dialog!.textContent ?? '';
    // employeeName mapped from the grid's own rows.
    expect(text).toContain('Aamir Mehmood');
    // old → new values surfaced from existing/proposed.
    expect(text).toContain('40');
    expect(text).toContain('55');
    // approverName from the response.
    expect(text).toContain('Morena Ruiz');
    // The raw error string is NOT shown in the grid error banner.
    expect(container.querySelector('[data-testid="grid-error"]')).toBeNull();
  });

  it('multiple pending changes queue one modal at a time; cancelling advances', async () => {
    const EMP2 = 'emp-bilal';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'requires_amendment',
              monthId: 'period-123',
              approverName: 'Morena Ruiz',
              pending: [
                {
                  bonus_employee_id: EMP,
                  change_type: 'update',
                  existing: { mattress_count: 40, note: null },
                  proposed: { mattress_count: 55, note: null },
                },
                {
                  bonus_employee_id: EMP2,
                  change_type: 'update',
                  existing: { mattress_count: 10, note: null },
                  proposed: { mattress_count: 22, note: null },
                },
              ],
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const rows: GridRowProps[] = [
      { bonus_employee_id: EMP, full_name: 'Aamir Mehmood', mattress_count: 40, note: null },
      { bonus_employee_id: EMP2, full_name: 'Bilal Khan', mattress_count: 10, note: null },
    ];
    mount(
      <DailyEntryGrid rule={rule} entryDate="2026-06-12" editable monthState="draft" rows={rows} />,
    );

    setInputValue(
      container.querySelector(`[data-testid="grid-count-${EMP}"]`) as HTMLInputElement,
      '55',
    );
    setInputValue(
      container.querySelector(`[data-testid="grid-count-${EMP2}"]`) as HTMLInputElement,
      '22',
    );
    clickSave();
    await flush();

    // First modal is for Aamir.
    let dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Aamir Mehmood');
    expect(dialog.textContent).not.toContain('Bilal Khan');

    // Cancel advances to the next queued change (Bilal).
    const cancelBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    act(() => cancelBtn.click());

    dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Bilal Khan');

    // Cancelling the last one drains the queue — no modal remains.
    const cancel2 = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    act(() => cancel2.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
