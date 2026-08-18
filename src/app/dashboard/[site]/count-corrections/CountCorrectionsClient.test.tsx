// @vitest-environment jsdom
//
// ADR-0105 — the RENDERED contract for the correction screen.
//
// The service tests prove a voided row is refused 422 `snapshot_voided`. These
// prove the thing that protects the manager from ever meeting that refusal: that
// a superseded row carries NO Correct affordance, and that when the server does
// refuse, its words reach the screen unaltered.
//
// The second one matters more than it looks. The 409 body already names the
// counted day, today, the earliest correctable day and the route to use instead.
// A client that re-words it produces a SECOND copy of the window rule which can
// drift from the one the server enforces — and the server's is the one that is
// true. So the test asserts the exact server sentence appears, not that "an error
// is shown".

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CountCorrectionsClient, type CountRowView } from './CountCorrectionsClient';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

let container: HTMLDivElement;
let root: Root;

function render(rows: CountRowView[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<CountCorrectionsClient siteCode="eugene" rows={rows} />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  refresh.mockClear();
});

function row(over: Partial<CountRowView> & { id: string }): CountRowView {
  return {
    countedDayISO: '2026-07-28',
    enteredAtISO: '2026-07-28T18:05:00.000Z',
    physicalTotal: 2_483,
    units_indoor: null,
    units_total: 2_483,
    units_in_processing: 0,
    enteredByUserId: 'user-jt',
    enteredByName: 'JT',
    isCorrection: false,
    correctedFromId: null,
    correctedToId: null,
    voidedAt: null,
    voidedByUserId: null,
    voidedByName: null,
    voidReason: null,
    correctable: true,
    ...over,
  };
}

const q = (sel: string) => container.querySelector(sel);
const text = () => container.textContent ?? '';

/**
 * Type into a controlled input the way React actually observes.
 *
 * Assigning `input.value` directly does NOT reach React 18: it installs its own
 * value setter on the element and diffs against a private tracker, so a direct
 * assignment is seen as "no change" and `onChange` never fires. The first version
 * of these tests did exactly that and submitted the INITIAL value while asserting
 * on the typed one — two tests failed with `expected 80 to equal 70`, which is the
 * correct answer for a field that was never edited. Going through the prototype's
 * native setter updates the tracker, so the dispatched event is a real change.
 */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ADR-0105 — the Correct affordance', () => {
  it('is offered on a live operator-entered count', () => {
    render([row({ id: 'snap-live' })]);
    expect(q('[data-testid="correct-snap-live"]')).not.toBeNull();
    expect(text()).toContain('JT');
    expect(text()).toContain('2,483');
  });

  it('is ABSENT on a row that has already been corrected away', () => {
    // The server would refuse this 422 `snapshot_voided`. Offering the button
    // anyway would walk the manager into a dead end that reads like a bug.
    render([
      row({
        id: 'snap-old',
        correctable: false,
        voidedAt: new Date(),
        voidReason: 'corrected',
        correctedToId: 'snap-new',
        voidedByName: 'Morena',
      }),
      row({
        id: 'snap-new',
        physicalTotal: 2_438,
        isCorrection: true,
        correctedFromId: 'snap-old',
      }),
    ]);
    expect(
      q('[data-testid="correct-snap-old"]'),
      'a superseded count still offered a Correct button — the screen offers an ' +
        'action the service refuses',
    ).toBeNull();
    // …and the live successor still does.
    expect(q('[data-testid="correct-snap-new"]')).not.toBeNull();
  });

  it('is ABSENT on a count withdrawn on the floor (ADR-0084)', () => {
    render([
      row({
        id: 'snap-void',
        correctable: false,
        voidedAt: new Date(),
        voidReason: 'withdrawn',
        voidedByName: 'JT',
      }),
    ]);
    expect(q('[data-testid="correct-snap-void"]')).toBeNull();
    expect(text()).toContain('withdrawn on the floor');
  });
});

describe('ADR-0105 — the chain is rendered honestly', () => {
  it('shows the superseded value struck through, and what replaced it', () => {
    render([
      row({
        id: 'snap-old',
        correctable: false,
        voidedAt: new Date(),
        voidReason: 'corrected',
        correctedToId: 'snap-new',
        voidedByName: 'Morena',
      }),
      row({
        id: 'snap-new',
        physicalTotal: 2_438,
        isCorrection: true,
        correctedFromId: 'snap-old',
      }),
    ]);
    // The prior number is still on the screen — never deleted, never hidden.
    expect(text()).toContain('2,483');
    const old = q('[data-testid="count-row-snap-old"]');
    expect(old?.querySelector('.line-through')?.textContent).toBe('2,483');
    // Both directions of the chain are stated.
    expect(text()).toContain('superseded by 2,438');
    expect(text()).toContain('corrected from 2,483');
    expect(text()).toContain('Morena');
  });

  it('uses no verdict language — it says what happened, not who was wrong', () => {
    render([
      row({
        id: 'snap-old',
        correctable: false,
        voidedAt: new Date(),
        voidReason: 'corrected',
        correctedToId: 'snap-new',
      }),
      row({
        id: 'snap-new',
        physicalTotal: 2_438,
        isCorrection: true,
        correctedFromId: 'snap-old',
      }),
    ]);
    const t = text().toLowerCase();
    for (const word of ['wrong', 'error', 'mistake', 'invalid', 'bad count', 'incorrect']) {
      expect(
        t,
        `the screen renders the verdict word "${word}" against an operator's count`,
      ).not.toContain(word);
    }
  });
});

describe('ADR-0105 — refusals reach the screen verbatim', () => {
  it("surfaces the server's 409 window message unaltered", async () => {
    const serverMessage =
      'This count was taken on 2026-07-26. Corrections reach back to 2026-07-27 (yesterday) only — today is 2026-07-28. An older count is changed from /admin/inventory/anchors, which writes a new anchor and leaves the original count in the chain.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'outside_correction_window', message: serverMessage }),
      })),
    );

    render([row({ id: 'snap-1' })]);
    act(() => {
      (q('[data-testid="correct-snap-1"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (q('[data-testid="save-snap-1"]') as HTMLButtonElement).click();
    });

    expect(q('[data-testid="correction-message"]')?.textContent).toBe(serverMessage);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('posts to the correction route and refreshes on success', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ corrected: true, toPhysicalTotal: 2_438 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render([row({ id: 'snap-1', units_total: 2_483, units_in_processing: 0 })]);
    act(() => {
      (q('[data-testid="correct-snap-1"]') as HTMLButtonElement).click();
    });
    act(() => type(q('[data-testid="input-snap-1"]') as HTMLInputElement, '2438'));
    await act(async () => {
      (q('[data-testid="save-snap-1"]') as HTMLButtonElement).click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/manager/eugene/snapshots/snap-1/correct');
    expect(init.method).toBe('POST');
    // An OR site counts on `units_total`; the corrected value must land on the
    // SAME column the original used, or the number changes meaning.
    expect(JSON.parse(init.body as string)).toEqual({
      units_indoor: null,
      units_total: 2438,
      units_in_processing: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(text()).toContain('The previous count is kept, marked superseded.');
  });

  it('a CA count writes back to units_indoor, not units_total', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ corrected: true, toPhysicalTotal: 90 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render([
      row({
        id: 'snap-ca',
        units_indoor: 80,
        units_total: null,
        units_in_processing: 20,
        physicalTotal: 100,
      }),
    ]);
    act(() => {
      (q('[data-testid="correct-snap-ca"]') as HTMLButtonElement).click();
    });
    act(() => type(q('[data-testid="input-snap-ca"]') as HTMLInputElement, '90'));
    await act(async () => {
      (q('[data-testid="save-snap-ca"]') as HTMLButtonElement).click();
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      units_indoor: 70,
      units_total: null,
      units_in_processing: 20,
    });
  });
});

describe('ADR-0105 — the empty case says why it is empty', () => {
  it('does not render a blank table', () => {
    render([]);
    expect(text()).toContain('No physical counts were recorded');
    expect(text()).toContain('/admin/inventory/anchors');
    expect(container.querySelector('table')).toBeNull();
  });
});
