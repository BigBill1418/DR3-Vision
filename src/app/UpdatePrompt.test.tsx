// @vitest-environment jsdom
//
// ADR-0027 — PWA update prompt. Two layers under test:
//   1. UpdateBanner — presentational: renders the translated strings and calls
//      back on Reload / Dismiss taps.
//   2. UpdatePrompt — DOM/SW logic: surfaces the banner when a worker is
//      waiting + the page is already controlled (a real update), posts
//      SKIP_WAITING on Reload, and reloads exactly once on controllerchange.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/i18n/provider';
import { getDictionary } from '@/i18n/dictionary';
import { UpdateBanner, UpdatePrompt } from './UpdatePrompt';

// Tell React this is a valid act() environment (required for createRoot +
// act() under React 18 outside of @testing-library).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = getDictionary('en');

function wrap(node: React.ReactNode) {
  return (
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>
  );
}

// A minimal EventTarget-backed fake of the bits of ServiceWorker* the
// component touches, so we can drive statechange / controllerchange / message.
class FakeWorker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
  setState(s: string) {
    this.state = s;
    this.dispatchEvent(new Event('statechange'));
  }
}

let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('UpdateBanner', () => {
  it('renders the translated strings and the reload/dismiss controls', () => {
    mount(wrap(<UpdateBanner onReload={() => {}} onDismiss={() => {}} />));
    const html = container.innerHTML;
    expect(html).toContain(dict.update_prompt.title);
    expect(html).toContain(dict.update_prompt.body);
    expect(html).toContain(dict.update_prompt.reload);
    expect(html).toContain(dict.update_prompt.dismiss);
  });

  it('calls onReload when the reload control is tapped', () => {
    const onReload = vi.fn();
    mount(wrap(<UpdateBanner onReload={onReload} onDismiss={() => {}} />));
    const buttons = Array.from(container.querySelectorAll('button'));
    const reloadBtn = buttons.find((b) => b.textContent === dict.update_prompt.reload)!;
    act(() => reloadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when the dismiss control is tapped', () => {
    const onDismiss = vi.fn();
    mount(wrap(<UpdateBanner onReload={() => {}} onDismiss={onDismiss} />));
    const buttons = Array.from(container.querySelectorAll('button'));
    const dismissBtn = buttons.find((b) => b.textContent === dict.update_prompt.dismiss)!;
    act(() => dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('UpdatePrompt', () => {
  function stubServiceWorker(reg: {
    waiting?: ServiceWorker | null;
    installing?: ServiceWorker | null;
  }) {
    // The registration is a real EventTarget (so `updatefound` can dispatch)
    // with the waiting/installing fields the component reads.
    const registration = Object.assign(new EventTarget(), {
      waiting: reg.waiting ?? null,
      installing: reg.installing ?? null,
    }) as unknown as ServiceWorkerRegistration;

    const swTarget = new EventTarget();
    const swMock = Object.assign(swTarget, {
      controller: {} as ServiceWorker, // page IS controlled → updates count
      getRegistration: vi.fn().mockResolvedValue(registration),
    });
    vi.stubGlobal('navigator', { serviceWorker: swMock });
    return { swMock, swTarget, registration };
  }

  it('renders nothing when no update is pending', async () => {
    stubServiceWorker({ waiting: null, installing: null });
    await act(async () => {
      mount(wrap(<UpdatePrompt />));
    });
    expect(container.querySelector('[data-testid="update-prompt"]')).toBeNull();
  });

  it('shows the banner when a worker is already waiting on mount', async () => {
    const waiting = new FakeWorker() as unknown as ServiceWorker;
    stubServiceWorker({ waiting });
    await act(async () => {
      mount(wrap(<UpdatePrompt />));
    });
    expect(container.querySelector('[data-testid="update-prompt"]')).not.toBeNull();
    expect(container.innerHTML).toContain(dict.update_prompt.title);
  });

  it('posts SKIP_WAITING to the waiting worker and reloads once on controllerchange', async () => {
    const waiting = new FakeWorker();
    const { swTarget } = stubServiceWorker({
      waiting: waiting as unknown as ServiceWorker,
    });
    const reload = vi.fn();
    // jsdom's location.reload is non-configurable; stub a fresh location.
    vi.stubGlobal('location', { reload });

    await act(async () => {
      mount(wrap(<UpdatePrompt />));
    });

    const reloadBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === dict.update_prompt.reload,
    )!;
    act(() => reloadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    // No reload yet — that waits for the new SW to take control.
    expect(reload).not.toHaveBeenCalled();

    // New SW activates and claims the client → controllerchange fires.
    act(() => swTarget.dispatchEvent(new Event('controllerchange')));
    act(() => swTarget.dispatchEvent(new Event('controllerchange')));
    expect(reload).toHaveBeenCalledOnce(); // guarded against loops
  });

  it('hides the banner after dismiss', async () => {
    const waiting = new FakeWorker() as unknown as ServiceWorker;
    stubServiceWorker({ waiting });
    await act(async () => {
      mount(wrap(<UpdatePrompt />));
    });
    const dismissBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === dict.update_prompt.dismiss,
    )!;
    act(() => dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-testid="update-prompt"]')).toBeNull();
  });
});
