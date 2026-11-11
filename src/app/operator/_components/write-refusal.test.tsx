// @vitest-environment jsdom
//
// ADR-0144 — the signed-out write refusal names the condition AND gives the way
// out. Before this it printed "Your sign-in session expired. Sign in again to
// continue." with no control under it, so the only route to the PIN screen was
// the chrome's Log Out or the connection badge — neither of which the sentence
// pointed at.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en/operator.json';

vi.mock('next/navigation', () => ({ usePathname: () => '/operator/woodland/count' }));
vi.mock('@/i18n/provider', async () => {
  const { getDictionary, translate } = await import('@/i18n/dictionary');
  const dict = getDictionary('en');
  return {
    useT: () => (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars),
    useLocale: () => 'en',
  };
});

import { WriteRefusalNotice } from './write-refusal';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(refusal: 'signed_out' | 'wrong_day') {
  render(
    <WriteRefusalNotice
      refusal={refusal}
      onRefresh={() => {}}
      siteCode="woodland"
      surface="count"
    />,
  );
}

describe('ADR-0144 — WriteRefusalNotice', () => {
  it('signed_out offers a sign-in control that returns to this screen', () => {
    mount('signed_out');
    const link = screen.getByTestId('write-refusal-sign-in');
    expect(link.tagName).toBe('A');
    expect(link.textContent).toBe(en.floor.action_outcome.sign_in);
    expect(link.getAttribute('href')).toBe(
      '/operator/woodland?next=%2Foperator%2Fwoodland%2Fcount',
    );
    expect(link.className).toContain('min-h-[56px]');
    expect(screen.queryByTestId('write-refusal-refresh')).toBeNull();
  });

  it('wrong_day keeps its reload and gets no sign-in control', () => {
    mount('wrong_day');
    expect(screen.getByTestId('write-refusal-refresh')).toBeTruthy();
    expect(screen.queryByTestId('write-refusal-sign-in')).toBeNull();
  });
});
