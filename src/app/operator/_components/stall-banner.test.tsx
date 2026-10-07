// @vitest-environment jsdom
// The watchdog: a transition pending too long raises the banner; settling lowers it.
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/provider', () => ({ useT: () => (k: string) => k }));

import { STALL_AFTER_MS, useWatchedTransition } from '@/lib/floor/use-watched-transition';
import { StallBanner } from './stall-banner';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness({ settle }: { settle: Promise<void> }) {
  const [, start] = useWatchedTransition();
  useEffect(() => {
    start(async () => {
      await settle;
    });
  }, [start, settle]);
  return <StallBanner />;
}

describe('stall watchdog', () => {
  it('shows the banner when a transition stays pending past the threshold, then clears it', async () => {
    let release!: () => void;
    const settle = new Promise<void>((r) => (release = r));
    render(<Harness settle={settle} />);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 100);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'stall.reload' })).toBeTruthy();

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a callback that throws still settles — it cannot leave the banner up', async () => {
    function Thrower() {
      const [, start] = useWatchedTransition();
      useEffect(() => {
        try {
          start(() => {
            throw new Error('boom');
          });
        } catch {
          /* the throw is the caller's to see; settling is what we assert */
        }
      }, [start]);
      return <StallBanner />;
    }
    render(<Thrower />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 100);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a prompt transition never raises it', async () => {
    render(<Harness settle={Promise.resolve()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 100);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
