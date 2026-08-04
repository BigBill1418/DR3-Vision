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

// ── ADR-0075 D2 — a collision is a fork, not a wall ─────────────────────────

describe('name collision', () => {
  const EXISTING = [
    {
      id: 'eq-1',
      displayName: 'Terex Machine',
      category: 'terex',
      siteCode: 'woodland',
      isActive: true,
      mergedIntoId: null,
    },
  ];

  function collisionFetch(existing: unknown[]) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Another equipment record at this site…', existing }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function submitColliding(node: React.ReactElement) {
    mount(node);
    setInput('admin-equipment-create-name', 'Terex machine');
    await act(async () => {
      click('admin-equipment-create-submit');
    });
  }

  it('renders the candidates AND both buttons when the 409 names what it collided with', async () => {
    collisionFetch(EXISTING);
    await submitColliding(
      <EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} initialSiteCode="woodland" />,
    );

    expect(container.querySelector('[data-testid="admin-equipment-similar"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="admin-equipment-use-existing-eq-1"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="admin-equipment-rename-mine"]')).not.toBeNull();
    // Never navigates away from the unsaved work.
    expect(push).not.toHaveBeenCalled();
  });

  it('"Use this one" fires onUseExisting with the candidate id', async () => {
    collisionFetch(EXISTING);
    const onUseExisting = vi.fn();
    await submitColliding(<EquipmentCreateForm sites={SITES} onUseExisting={onUseExisting} />);

    await act(async () => {
      click('admin-equipment-use-existing-eq-1');
    });
    expect(onUseExisting).toHaveBeenCalledWith('eq-1', true);
  });

  it('labels the button "Reactivate and use" for an INACTIVE candidate', async () => {
    collisionFetch([{ ...EXISTING[0], isActive: false }]);
    await submitColliding(<EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} />);

    const btn = container.querySelector('[data-testid="admin-equipment-use-existing-eq-1"]');
    expect(btn?.textContent).toContain('Reactivate');
  });

  it('offers NO button for a merged candidate — it is shown, not offerable', async () => {
    collisionFetch([{ ...EXISTING[0], mergedIntoId: 'eq-9' }]);
    await submitColliding(<EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} />);

    expect(container.querySelector('[data-testid="admin-equipment-similar-eq-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="admin-equipment-use-existing-eq-1"]')).toBeNull();
  });

  it('"Rename mine" clears the field and drops the suggestion block', async () => {
    collisionFetch(EXISTING);
    await submitColliding(<EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} />);

    await act(async () => {
      click('admin-equipment-rename-mine');
    });
    const name = container.querySelector(
      '[data-testid="admin-equipment-create-name"]',
    ) as HTMLInputElement;
    expect(name.value).toBe('');
    expect(container.querySelector('[data-testid="admin-equipment-similar"]')).toBeNull();
  });

  it('a 409 with NO candidates falls back to the plain banner', async () => {
    // The P2002 race backstop has no candidate list to offer.
    collisionFetch([]);
    await submitColliding(<EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} />);

    expect(container.querySelector('[data-testid="admin-equipment-similar"]')).toBeNull();
    expect(errorText()).toContain('Another equipment record');
  });

  it('the ADMIN create page passes neither prop — no lookup fires and a 409 is a plain banner', async () => {
    const fetchMock = collisionFetch(EXISTING);
    await submitColliding(<EquipmentCreateForm sites={SITES} />);

    // Exactly ONE request: the create POST. No similar-name lookup at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Candidates are shown for context, but with nowhere to send the choice
    // there is no "use this one" button.
    expect(container.querySelector('[data-testid="admin-equipment-use-existing-eq-1"]')).toBeNull();
    expect(errorText()).toBeTruthy();
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
