// @vitest-environment jsdom
//
// ADR-0063 — create-equipment form navigation + site-default guards.
//
// These lock down, on day one, the two defects PR #176 had to retrofit onto
// `/admin/users` (ADR-0017 Amendment 1):
//   1. save and cancel must return to the list WITH the admin's filters, not a
//      hard-coded '/admin/equipment';
//   2. the site select must seed from the `?site=` filter, not `sites[0]`.
//      Sites are ordered by name and 'DR3 Eugene' sorts before 'DR3 Woodland',
//      so `sites[0]` is ALWAYS Eugene — an asset created from a Woodland-scoped
//      list would be born in Eugene and surface in the wrong site's AP approver
//      picker. That crosses the Eugene/Woodland separation line (hard rule #2).

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EquipmentCreateForm } from './EquipmentCreateForm';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Ordered by name, exactly as `prisma.site.findMany({ orderBy: { name: 'asc' } })`
// returns them in the page — Eugene first. That ordering IS the bug surface.
const SITES = [
  { id: 'site-eugene', code: 'eugene', name: 'DR3 Eugene' },
  { id: 'site-woodland', code: 'woodland', name: 'DR3 Woodland' },
];

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  push.mockReset();
  refresh.mockReset();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

function setInput(testid: string, value: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function siteSelect(): HTMLSelectElement {
  return container.querySelector(
    '[data-testid="admin-equipment-create-site"]',
  ) as HTMLSelectElement;
}

function categorySelect(): HTMLSelectElement {
  return container.querySelector(
    '[data-testid="admin-equipment-create-category"]',
  ) as HTMLSelectElement;
}

function errorText(): string | null {
  return (
    container.querySelector('[data-testid="admin-equipment-create-error"]')?.textContent ?? null
  );
}

function okFetch() {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ equipment: { id: 'eq1' } }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('site default', () => {
  it('defaults to the site the list was filtered to (Woodland), not sites[0]', () => {
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="woodland" />);
    expect(siteSelect().value).toBe('site-woodland');
  });

  it('falls back to sites[0] when the list had no site filter', () => {
    mount(<EquipmentCreateForm sites={SITES} />);
    expect(siteSelect().value).toBe('site-eugene');
  });

  it('falls back to sites[0] for an unknown site code', () => {
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="nowhere" />);
    expect(siteSelect().value).toBe('site-eugene');
  });

  it('POSTs the Woodland site id when created from a Woodland-scoped list', async () => {
    const fetchMock = okFetch();
    mount(
      <EquipmentCreateForm
        sites={SITES}
        initialSiteCode="woodland"
        backHref="/admin/equipment?site=woodland"
      />,
    );
    setInput('admin-equipment-create-name', 'EQ99 — Hyster Forklift');
    await act(async () => {
      click('admin-equipment-create-submit');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      site_id: string;
      display_name: string;
      category: string;
    };
    expect(body.site_id).toBe('site-woodland');
    expect(body.display_name).toBe('EQ99 — Hyster Forklift');
  });
});

describe('category default', () => {
  it('seeds from the list filter so creating from a Forklift view stays a forklift', () => {
    mount(<EquipmentCreateForm sites={SITES} initialCategory="forklift" />);
    expect(categorySelect().value).toBe('forklift');
  });

  it('falls back to vehicle with no category filter', () => {
    mount(<EquipmentCreateForm sites={SITES} />);
    expect(categorySelect().value).toBe('vehicle');
  });
});

describe('navigation', () => {
  it('returns to the FILTERED list on save, not the bare list', async () => {
    okFetch();
    const backHref = '/admin/equipment?site=woodland&category=terex&status=all';
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="woodland" backHref={backHref} />);
    setInput('admin-equipment-create-name', 'EQ74 — Terex Shear');
    await act(async () => {
      click('admin-equipment-create-submit');
    });

    expect(push).toHaveBeenCalledWith(backHref);
    expect(refresh).toHaveBeenCalled();
  });

  it('returns to the FILTERED list on cancel', () => {
    const backHref = '/admin/equipment?site=woodland';
    mount(<EquipmentCreateForm sites={SITES} backHref={backHref} />);
    click('admin-equipment-create-cancel');
    expect(push).toHaveBeenCalledWith(backHref);
  });

  it('does not navigate when the server rejects the create', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: 'Another equipment record at this site already uses that name.',
        }),
      }),
    );
    mount(<EquipmentCreateForm sites={SITES} backHref="/admin/equipment?site=woodland" />);
    setInput('admin-equipment-create-name', 'EQ43 — Terex Shear');
    await act(async () => {
      click('admin-equipment-create-submit');
    });

    expect(push).not.toHaveBeenCalled();
    expect(errorText()).toContain('already uses that name');
  });
});

describe('client-side validation', () => {
  it('refuses an empty name without hitting the API', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    await act(async () => {
      click('admin-equipment-create-submit');
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorText()).toBeTruthy();
  });

  it('refuses a whitespace-only name', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    setInput('admin-equipment-create-name', '    ');
    await act(async () => {
      click('admin-equipment-create-submit');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims the name before POSTing', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    setInput('admin-equipment-create-name', '  EQ12 — Ford F-350  ');
    await act(async () => {
      click('admin-equipment-create-submit');
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { display_name: string };
    expect(body.display_name).toBe('EQ12 — Ford F-350');
  });
});
