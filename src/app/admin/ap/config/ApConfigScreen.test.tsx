// @vitest-environment jsdom
//
// ADR-0066 §1.4/§1.6 — the combined AP configuration screen.
//
// The load-bearing assertion is `omits the email-less operator PIN account`.
// In production Bill and Morena each have a second, email-less operator account
// with the SAME NAME as their manager/admin account. A picker keyed on name
// would let an admin select one; the routing table would then read as fully
// populated while every second-approval notification resolved to nobody — the
// exact defect ADR-0066 exists to fix, reintroduced through its own UI.

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApConfigDto, ApPersonRef } from '@/lib/ap/admin-config';
import { ApConfigScreen } from './ApConfigScreen';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  refresh.mockReset();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

function click(testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
  expect(el, `missing [data-testid="${testid}"]`).toBeTruthy();
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const person = (p: Partial<ApPersonRef> & { id: string; name: string }): ApPersonRef => ({
  email: null,
  role: 'manager',
  is_active: true,
  reachable: false,
  ...p,
});

const BILL = person({
  id: 'u-bill',
  name: 'Bill Barnard',
  email: 'bill.barnard@svdp.us',
  role: 'admin',
  reachable: true,
});
// Same NAME, no email, operator role — created 2026-07-28 for the iPad rollout.
const BILL_OP = person({ id: 'u-bill-op', name: 'Bill Barnard', role: 'operator' });
const MORENA = person({
  id: 'u-morena',
  name: 'Morena Gomez',
  email: 'morena.gomez@svdp.us',
  reachable: true,
});
const MORENA_OP = person({ id: 'u-morena-op', name: 'Morena Gomez', role: 'operator' });
const RICK = person({
  id: 'u-rick',
  name: 'Rick Albritton',
  email: 'rick.albritton@svdp.us',
  reachable: true,
});

function makeConfig(over: Partial<ApConfigDto> = {}): ApConfigDto {
  const approvers = [BILL, MORENA, RICK];
  return {
    routing: [
      {
        id: 'r-1',
        first_approver: MORENA,
        second_approver: RICK,
        fallback_approver: null,
        fallback_after_hours: 24,
        active: true,
        updated_at: '2026-07-29T12:00:00.000Z',
        updated_by: 'system:adr-0066-seed',
      },
    ],
    prefs: approvers.map((p) => ({
      person: p,
      has_row: p.id === 'u-morena',
      values: {
        new_invoice: true,
        second_approval_request: true,
        daily_digest: false,
        decision_outcome: false,
      },
      updated_at: null,
    })),
    approvers,
    selectable: approvers,
    namesakes: [BILL_OP, MORENA_OP],
    problems: [
      {
        code: 'missing_routing_row',
        severity: 'error',
        subjectUserId: RICK.id,
        message: 'No active ap_approval_routing row for first approver Rick Albritton — …',
      },
    ],
    defaults: {
      new_invoice: true,
      second_approval_request: true,
      daily_digest: false,
      decision_outcome: false,
    },
    events: ['new_invoice', 'second_approval_request', 'daily_digest', 'decision_outcome'],
    ...over,
  };
}

function optionValues(testid: string): string[] {
  const sel = container.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement;
  expect(sel, `missing [data-testid="${testid}"]`).toBeTruthy();
  return [...sel.options].map((o) => o.value);
}

describe('second-approver picker', () => {
  it('omits the email-less operator PIN account even though its name matches an approver', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'active' }} />);
    // Open the editor on Rick, so Bill's TWO accounts are both candidate peers
    // and only the reachable one may be offered.
    click(`ap-config-fix-${RICK.id}`);
    const values = optionValues('ap-routing-second');
    expect(values).not.toContain(BILL_OP.id);
    expect(values).not.toContain(MORENA_OP.id);
    expect(values).toContain(BILL.id);
    expect(values).toContain(MORENA.id);
  });

  it('never offers the first approver as their own second approver', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'active' }} />);
    click('ap-routing-add');
    const first = (container.querySelector('[data-testid="ap-routing-first"]') as HTMLSelectElement)
      .value;
    expect(optionValues('ap-routing-second')).not.toContain(first);
    expect(optionValues('ap-routing-fallback')).not.toContain(first);
  });

  it('labels every option with its email, so two same-named accounts are distinguishable', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'active' }} />);
    click('ap-routing-add');
    const sel = container.querySelector('[data-testid="ap-routing-second"]') as HTMLSelectElement;
    for (const opt of [...sel.options]) expect(opt.textContent).toContain('@svdp.us');
  });

  it('never displays one peer while holding another', () => {
    // A row already pointing at somebody unreachable (deactivated, or an
    // email-less account) has no matching <option>. Left alone, the select
    // renders the first peer while the draft still holds the broken id — save
    // then writes something the admin never saw.
    const broken = person({ id: 'u-gone', name: 'Gone Person', role: 'manager', is_active: false });
    mount(
      <ApConfigScreen
        config={makeConfig({
          routing: [
            {
              id: 'r-broken',
              first_approver: MORENA,
              second_approver: broken,
              fallback_approver: null,
              fallback_after_hours: 24,
              active: true,
              updated_at: '2026-07-29T12:00:00.000Z',
              updated_by: null,
            },
          ],
        })}
        view="routing"
        params={{ status: 'active' }}
      />,
    );
    click(`ap-routing-edit-${MORENA.id}`);
    const sel = container.querySelector('[data-testid="ap-routing-second"]') as HTMLSelectElement;
    expect(sel.value).not.toBe(broken.id);
    expect(optionValues('ap-routing-second')).toContain(sel.value);
  });

  it('discloses the excluded namesakes rather than hiding them', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'active' }} />);
    expect(container.querySelector(`[data-testid="ap-namesake-${BILL_OP.id}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-testid="ap-namesake-${MORENA_OP.id}"]`)).toBeTruthy();
  });
});

describe('configuration warnings', () => {
  it('surfaces a missing routing row', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'active' }} />);
    const el = container.querySelector('[data-testid="ap-config-problem-missing_routing_row"]');
    expect(el?.textContent).toContain('Rick Albritton');
  });

  it('opens the editor pre-filled with the flagged person', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'active' }} />);
    click(`ap-config-fix-${RICK.id}`);
    const first = container.querySelector('[data-testid="ap-routing-first"]') as HTMLSelectElement;
    expect(first.value).toBe(RICK.id);
  });

  it('shows the all-clear panel when there is nothing wrong', () => {
    mount(
      <ApConfigScreen
        config={makeConfig({ problems: [] })}
        view="routing"
        params={{ status: 'active' }}
      />,
    );
    expect(container.querySelector('[data-testid="ap-config-problems-none"]')).toBeTruthy();
  });
});

describe('notification preferences grid', () => {
  it('renders decision_outcome but makes it un-flippable', () => {
    mount(
      <ApConfigScreen config={makeConfig()} view="notifications" params={{ status: 'active' }} />,
    );
    const box = container.querySelector(
      `[data-testid="ap-pref-${RICK.id}-decision_outcome"]`,
    ) as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
  });

  it('leaves the wired events flippable', () => {
    mount(
      <ApConfigScreen config={makeConfig()} view="notifications" params={{ status: 'active' }} />,
    );
    for (const ev of ['new_invoice', 'second_approval_request', 'daily_digest']) {
      const box = container.querySelector(
        `[data-testid="ap-pref-${RICK.id}-${ev}"]`,
      ) as HTMLInputElement;
      expect(box.disabled).toBe(false);
    }
  });

  it('captions second_approval_request as targeted, not a broadcast', () => {
    mount(
      <ApConfigScreen config={makeConfig()} view="notifications" params={{ status: 'active' }} />,
    );
    const box = container.querySelector(
      `[data-testid="ap-pref-${RICK.id}-second_approval_request"]`,
    ) as HTMLInputElement;
    expect(box.title).toMatch(/NOT a broadcast/);
    expect(box.title).toMatch(/routed to THEM/);
  });

  it('marks a person with no stored row as running on defaults', () => {
    mount(
      <ApConfigScreen config={makeConfig()} view="notifications" params={{ status: 'active' }} />,
    );
    expect(container.querySelector(`[data-testid="ap-prefs-defaults-${RICK.id}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-testid="ap-prefs-defaults-${MORENA.id}"]`)).toBeNull();
  });
});

describe('the two routes are one surface', () => {
  it('cross-links carry the current view state', () => {
    mount(<ApConfigScreen config={makeConfig()} view="routing" params={{ status: 'all' }} />);
    const tab = container.querySelector(
      '[data-testid="ap-config-tab-notifications"]',
    ) as HTMLAnchorElement;
    expect(tab.getAttribute('href')).toBe('/admin/ap/notifications?status=all');
  });
});
