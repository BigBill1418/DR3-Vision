// @vitest-environment jsdom
//
// ADR-0057 — MyMRC admin-credential form behavior guards.
//
// Covers the security-load-bearing UX contracts:
//   1. no <form> element (CLAUDE.md hard rule #10); password input is type=password;
//   2. write-only password: when already configured, the field renders BLANK with a
//      "set" placeholder and a "never pre-filled" note — the value is never shown;
//   3. client validation blocks a save with a blank username or password (no fetch);
//   4. a successful save POSTs to the credentials endpoint, then CLEARS the password
//      from the field and shows a success notice.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MrcScrapeForm } from './MrcScrapeForm';
import { adminMessages as M } from '@/app/admin/messages';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
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

function setInput(testid: string, value: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickSubmit() {
  const btn = container.querySelector('[data-testid="mrc-submit"]') as HTMLButtonElement;
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

const UNCONFIGURED = { configured: false, username: null, updatedAt: null, updatedBy: null };
const CONFIGURED = {
  configured: true,
  username: 'bill@svdp.us',
  updatedAt: '2026-07-20T18:30:00.000Z',
  updatedBy: 'admin-1',
};

describe('MrcScrapeForm — structure & write-only password', () => {
  it('renders username + password inputs, a submit button, and NO <form> element', () => {
    mount(<MrcScrapeForm {...UNCONFIGURED} />);
    expect(container.querySelector('form')).toBeNull();
    const pw = container.querySelector('[data-testid="mrc-password"]') as HTMLInputElement;
    expect(pw).not.toBeNull();
    expect(pw.getAttribute('type')).toBe('password');
    expect(pw.getAttribute('autocomplete')).toBe('new-password');
    expect(container.querySelector('[data-testid="mrc-username"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mrc-submit"]')).not.toBeNull();
  });

  it('shows the not-configured status and an empty password field with no set-placeholder', () => {
    mount(<MrcScrapeForm {...UNCONFIGURED} />);
    const status = container.querySelector('[data-testid="mrc-status"]')!;
    expect(status.getAttribute('data-configured')).toBe('false');
    expect(status.textContent).toContain(M.mrc.statusNotConfigured);
    const pw = container.querySelector('[data-testid="mrc-password"]') as HTMLInputElement;
    expect(pw.value).toBe('');
    expect(pw.getAttribute('placeholder')).toBe('');
  });

  it('when configured: username is prefilled, password is BLANK with the "set" placeholder + note, and the real password is never in the DOM', () => {
    mount(<MrcScrapeForm {...CONFIGURED} />);
    const status = container.querySelector('[data-testid="mrc-status"]')!;
    expect(status.getAttribute('data-configured')).toBe('true');
    expect(status.textContent).toContain(M.mrc.statusConfigured);

    const user = container.querySelector('[data-testid="mrc-username"]') as HTMLInputElement;
    expect(user.value).toBe('bill@svdp.us');

    const pw = container.querySelector('[data-testid="mrc-password"]') as HTMLInputElement;
    // Write-only: never pre-filled, placeholder signals a stored secret.
    expect(pw.value).toBe('');
    expect(pw.getAttribute('placeholder')).toBe(M.mrc.passwordSetPlaceholder);
    expect(container.textContent).toContain(M.mrc.passwordHelpSet);
  });
});

describe('MrcScrapeForm — validation', () => {
  it('blocks save with a blank username and never fires fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(<MrcScrapeForm {...UNCONFIGURED} />);
    setInput('mrc-password', 'pw');
    clickSubmit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mrc-error"]')?.textContent).toBe(
      M.mrc.usernameRequired,
    );
  });

  it('blocks save with a blank password and never fires fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(<MrcScrapeForm {...UNCONFIGURED} />);
    setInput('mrc-username', 'bill');
    clickSubmit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mrc-error"]')?.textContent).toBe(
      M.mrc.passwordRequired,
    );
  });
});

describe('MrcScrapeForm — successful save', () => {
  it('POSTs to the credentials endpoint, then clears the password and shows a success notice', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    mount(<MrcScrapeForm {...UNCONFIGURED} />);

    setInput('mrc-username', 'bill@svdp.us');
    setInput('mrc-password', 'sup3r-s3cret!');

    await act(async () => {
      (container.querySelector('[data-testid="mrc-submit"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/mrc-scrape/credentials');
    expect((init as RequestInit).method).toBe('POST');
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody).toEqual({ username: 'bill@svdp.us', password: 'sup3r-s3cret!' });

    // Password cleared from the field after save; success notice shown.
    const pw = container.querySelector('[data-testid="mrc-password"]') as HTMLInputElement;
    expect(pw.value).toBe('');
    expect(container.querySelector('[data-testid="mrc-notice"]')?.textContent).toContain(
      M.mrc.saved,
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('surfaces the server error and does not clear the password on failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) });
    vi.stubGlobal('fetch', fetchMock);
    mount(<MrcScrapeForm {...UNCONFIGURED} />);

    setInput('mrc-username', 'bill');
    setInput('mrc-password', 'pw');

    await act(async () => {
      (container.querySelector('[data-testid="mrc-submit"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="mrc-error"]')?.textContent).toBe('boom');
    const pw = container.querySelector('[data-testid="mrc-password"]') as HTMLInputElement;
    expect(pw.value).toBe('pw');
  });
});
