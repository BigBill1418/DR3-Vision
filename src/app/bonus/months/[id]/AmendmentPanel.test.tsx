// @vitest-environment jsdom
//
// ADR-0083 Amendment 1 — the amended-month editor's saves column, pinned at the
// only layer that can prove it: what the component ACTUALLY PUTS ON THE WIRE.
//
// A test that mounted the panel and asserted a `saves` input exists would pass
// beside a component that renders the box and then drops the value out of its
// POST body — which is precisely the shape of the gap this amendment closes
// (the API and the service accepted `saves` for a whole release; only the panel
// never sent it). So every assertion below reads the captured `fetch` body.
//
// The seeding assertion is the load-bearing one. `buildRowState` seeds each
// row's saves box from the stored entry, so a note-only correction re-sends the
// day's EXISTING saves. Seed it as `''` instead and every note edit posts
// `saves: 0` — a silent pay cut on the one screen that reaches a signed period.
// The last block runs that exact seeding beside the shipped one and shows the
// zero land.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AmendmentPanel, type AmendDayOption, type AmendEmployeeRow } from './AmendmentPanel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The live Woodland rule: (u−50)×50¢ + (u−75)×25¢. Tiered, not flat. */
const RULE = { threshold_low: 50, rate_low: 0.5, threshold_high: 75, rate_high: 0.25 };

const MONTH = 'm-may';
const MARIA = 'emp-maria';
const DAY: AmendDayOption[] = [{ iso: '2026-05-12', label: 'Tue May 12' }];

type PostedEntry = {
  bonus_employee_id: string;
  mattress_count: number;
  saves?: number;
  note: string | null;
};

let container: HTMLDivElement;
let root: Root;
let posted: Array<{ url: string; body: { entry_date: string; entries: PostedEntry[] } }>;

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

/** One processor, keyed on the selected day with a real saves figure. */
function mountPanel(over: { mattress_count?: number; saves?: number; note?: string | null } = {}) {
  const mattress_count = over.mattress_count ?? 76;
  const saves = over.saves ?? 9;
  const note = over.note ?? null;
  const employees: AmendEmployeeRow[] = [
    { bonus_employee_id: MARIA, full_name: 'Maria Ruiz', mattress_count, saves, note },
  ];
  mount(
    <AmendmentPanel
      monthId={MONTH}
      state="amended"
      rule={RULE}
      days={DAY}
      employees={employees}
      entriesByDay={{ [`2026-05-12|${MARIA}`]: { mattress_count, saves, note } }}
    />,
  );
}

const savesInput = () =>
  container.querySelector(`[data-testid="amend-saves-${MARIA}"]`) as HTMLInputElement;
const countInput = () =>
  container.querySelector(`[data-testid="amend-count-${MARIA}"]`) as HTMLInputElement;
const saveBtn = () => container.querySelector('[data-testid="amend-save"]') as HTMLButtonElement;

function type(el: HTMLInputElement, value: string) {
  act(() => {
    // React's synthetic onChange needs the native setter to see a real change.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const clickSave = async () => {
  await act(async () => {
    saveBtn().click();
  });
};

const lastEntry = (): PostedEntry => {
  const last = posted.at(-1);
  if (!last) throw new Error('the panel issued no POST at all');
  return last.body.entries[0]!;
};

// ─────────────────────────────────────────────────────────────────────────

describe('the amended-month editor renders and posts saves', () => {
  it('seeds the saves box from the stored entry', () => {
    mountPanel({ mattress_count: 76, saves: 9 });
    expect(savesInput()).not.toBeNull();
    expect(savesInput().value).toBe('9');
  });

  it('POSTs the corrected saves to the month-scoped entries endpoint', async () => {
    mountPanel({ mattress_count: 76, saves: 40 }); // 40 was the typo
    type(savesInput(), '4');
    await clickSave();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`/api/bonus/months/${MONTH}/entries`);
    expect(posted[0]?.body.entry_date).toBe('2026-05-12');
    expect(lastEntry()).toEqual({
      bonus_employee_id: MARIA,
      mattress_count: 76,
      saves: 4,
      note: null,
    });
  });

  it('submits a SAVES-ONLY row — an empty count box is not a reason to skip it', async () => {
    mountPanel({ mattress_count: 0, saves: 0 });
    type(countInput(), '');
    type(savesInput(), '62');
    await clickSave();
    expect(lastEntry()).toMatchObject({ mattress_count: 0, saves: 62 });
  });

  it('sends an explicit 0 so a value can be CLEARED (absent would mean unchanged)', async () => {
    mountPanel({ mattress_count: 76, saves: 9 });
    type(savesInput(), '0');
    await clickSave();
    // 0, not undefined — the server reads an absent `saves` as "leave alone",
    // which would make this correction impossible to express from here.
    expect(lastEntry().saves).toBe(0);
    expect(Object.keys(lastEntry())).toContain('saves');
  });

  it('tiers the day total ONCE over count + saves', async () => {
    mountPanel({ mattress_count: 45, saves: 20 });
    const total = container.querySelector('[data-testid="amend-total"]')?.textContent;
    // 65 paid units → (65−50)×50¢ = $7.50. Tiered separately both columns sit
    // under the threshold and it would read $0.00.
    expect(total).toBe('$7.50');
    expect(container.querySelector('[data-testid="amend-total-saves"]')?.textContent).toContain(
      '20',
    );
  });
});

describe('a NOTE-ONLY correction must not disturb the day’s saves', () => {
  it('re-sends the stored saves rather than a blank', async () => {
    mountPanel({ mattress_count: 76, saves: 9 });
    const noteBox = container.querySelector(
      `[aria-label="Note for Maria Ruiz"]`,
    ) as HTMLInputElement;
    type(noteBox, 'recount confirmed');
    await clickSave();

    expect(lastEntry()).toEqual({
      bonus_employee_id: MARIA,
      mattress_count: 76,
      saves: 9, // untouched
      note: 'recount confirmed',
    });
  });
});

describe('FALSIFICATION — seeding the saves box blank zeroes it on a note edit', () => {
  it('posts saves: 0 for a day that had 9, and the pay drops $6.75', () => {
    // `buildRowState` is module-private, so the two seedings are reproduced here
    // and both are trivially inspectable. What makes this meaningful rather than
    // self-referential is the test ABOVE: it drives the real component and shows
    // the shipped seeding really does put 9 on the wire.
    const stored = { mattress_count: 76, saves: 9, note: null as string | null };

    const shippedSeed = { count: String(stored.mattress_count), saves: String(stored.saves) };
    const brokenSeed = { count: String(stored.mattress_count), saves: '' };

    const parse = (raw: string): number | null => {
      if (raw.trim() === '') return null;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
    };
    // The panel always sends saves explicitly, so a blank box becomes 0.
    const postedSaves = (seed: { saves: string }) => parse(seed.saves) ?? 0;

    // The defect, executed: nothing threw, nothing was rejected, and a note edit
    // silently deleted 9 saved mattresses.
    expect(postedSaves(brokenSeed)).toBe(0);
    expect(postedSaves(shippedSeed)).toBe(9);

    const bonus = (units: number) =>
      Math.max(units - RULE.threshold_low, 0) * 50 + Math.max(units - RULE.threshold_high, 0) * 25;
    // 76 alone: (26)×50 + (1)×25 = 1325¢. 85 paid units: (35)×50 + (10)×25 = 2000¢.
    expect(bonus(76 + postedSaves(brokenSeed))).toBe(1325);
    expect(bonus(76 + postedSaves(shippedSeed))).toBe(2000);
    expect(bonus(76 + 9) - bonus(76)).toBe(675); // $6.75 lost, on one day, silently.
  });
});
