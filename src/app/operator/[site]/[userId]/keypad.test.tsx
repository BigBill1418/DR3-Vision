// @vitest-environment jsdom
// The PIN keypad must give the keys back if sign-in never answers.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({ signIn: (...a: unknown[]) => signInMock(...a) }));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('@/i18n/provider', () => ({ useT: () => (k: string) => k }));

import { Keypad } from './keypad';

beforeEach(() => {
  vi.useFakeTimers();
  signInMock.mockReset();
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function isDisabled(name: string): boolean {
  return (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
}

function enterPin() {
  for (const d of ['1', '2', '3', '4']) fireEvent.click(screen.getByRole('button', { name: d }));
}

describe('Keypad stall escapes', () => {
  it('re-enables the keys when signIn never resolves', async () => {
    signInMock.mockReturnValue(new Promise(() => {}));
    render(<Keypad userId="u1" siteCode="woodland" />);
    enterPin();
    expect(isDisabled('1')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(isDisabled('1')).toBe(false);
    expect(screen.getByText('keypad.error_failed')).toBeTruthy();
  });

  it('re-enables the keys when sign-in succeeds but the navigation never lands', async () => {
    signInMock.mockResolvedValue({ error: undefined });
    render(<Keypad userId="u1" siteCode="woodland" />);
    enterPin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(push).toHaveBeenCalled();
    expect(isDisabled('1')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(isDisabled('1')).toBe(false);
  });

  it('a working navigation (unmount) never fires the stall reset', async () => {
    signInMock.mockResolvedValue({ error: undefined });
    const { unmount } = render(<Keypad userId="u1" siteCode="woodland" />);
    enterPin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
