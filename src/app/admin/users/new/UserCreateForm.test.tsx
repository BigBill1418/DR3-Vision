// @vitest-environment jsdom
//
// ADR-0017 — create-user form navigation + site-default guards.
//
// Two defects this locks down, both reported from the floor workflow
// "filter the user list to Woodland → + Add user → save":
//   1. save (and cancel) pushed a hard-coded '/admin/users', dropping the
//      admin's filters and dumping them on the all-users list;
//   2. the site select defaulted to sites[0] — always Eugene, since sites
//      are ordered by name and 'DR3 Eugene' sorts before 'DR3 Woodland' —
//      so a user created from a Woodland-scoped list was born in Eugene
//      unless the admin noticed and flipped the select. That crosses the
//      Eugene/Woodland separation line (CLAUDE.md hard rule #2).

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UserCreateForm } from './UserCreateForm';

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
  return container.querySelector('[data-testid="admin-create-site"]') as HTMLSelectElement;
}

function fillValidOperator() {
  setInput('admin-create-name', 'Ana Ruiz');
  setInput('admin-create-pin', '1234');
  setInput('admin-create-pin-confirm', '1234');
}

describe('site default', () => {
  it('defaults to the site the list was filtered to (Woodland), not sites[0]', () => {
    mount(<UserCreateForm sites={SITES} initialSiteCode="woodland" />);
    expect(siteSelect().value).toBe('site-woodland');
  });

  it('still falls back to sites[0] when the list had no site filter', () => {
    mount(<UserCreateForm sites={SITES} />);
    expect(siteSelect().value).toBe('site-eugene');
  });

  it('falls back to sites[0] for an unknown site code', () => {
    mount(<UserCreateForm sites={SITES} initialSiteCode="stockton" />);
    expect(siteSelect().value).toBe('site-eugene');
  });

  it('POSTs the Woodland site id when created from a Woodland-scoped list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'u1' } }) });
    vi.stubGlobal('fetch', fetchMock);

    mount(
      <UserCreateForm
        sites={SITES}
        initialSiteCode="woodland"
        backHref="/admin/users?site=woodland"
      />,
    );
    fillValidOperator();
    await act(async () => {
      click('admin-create-submit');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      primary_site_id: string;
      role: string;
    };
    expect(body.primary_site_id).toBe('site-woodland');
    expect(body.role).toBe('operator');
  });
});

describe('post-save navigation', () => {
  it('returns to the filtered list, not the all-users list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'u1' } }) });
    vi.stubGlobal('fetch', fetchMock);

    mount(
      <UserCreateForm
        sites={SITES}
        initialSiteCode="woodland"
        backHref="/admin/users?site=woodland&role=operator"
      />,
    );
    fillValidOperator();
    await act(async () => {
      click('admin-create-submit');
    });

    expect(push).toHaveBeenCalledWith('/admin/users?site=woodland&role=operator');
    expect(push).not.toHaveBeenCalledWith('/admin/users');
  });

  it('cancel returns to the same filtered list', () => {
    mount(<UserCreateForm sites={SITES} backHref="/admin/users?site=woodland" />);
    click('admin-create-cancel');
    expect(push).toHaveBeenCalledWith('/admin/users?site=woodland');
  });

  it('does not navigate when the save fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ error: 'PIN already in use' }) });
    vi.stubGlobal('fetch', fetchMock);

    mount(<UserCreateForm sites={SITES} backHref="/admin/users?site=woodland" />);
    fillValidOperator();
    await act(async () => {
      click('admin-create-submit');
    });

    expect(push).not.toHaveBeenCalled();
    const err = container.querySelector('[data-testid="admin-create-error"]');
    expect(err?.textContent).toContain('PIN already in use');
  });

  it('falls back to the bare list when no backHref is supplied', () => {
    mount(<UserCreateForm sites={SITES} />);
    click('admin-create-cancel');
    expect(push).toHaveBeenCalledWith('/admin/users');
  });
});
