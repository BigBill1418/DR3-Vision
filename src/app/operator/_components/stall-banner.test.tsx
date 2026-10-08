// @vitest-environment jsdom
// The watchdog: a transition pending too long raises the banner; settling lowers it.
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/provider', () => ({ useT: () => (k: string) => k }));

import {
  STALL_AFTER_MS,
  useStallWatch,
  useWatchedTransition,
} from '@/lib/floor/use-watched-transition';
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

// ADR-0140 Am.1 — the same watchdog around a plain async handler (the useState-busy
// floor screens: count, void, inbound, processed, queue conflicts).
describe('useStallWatch', () => {
  function WatchHarness({ settle }: { settle: Promise<void> }) {
    const watch = useStallWatch();
    useEffect(() => {
      void watch(async () => {
        await settle;
      });
    }, [watch, settle]);
    return <StallBanner />;
  }

  it('raises the banner for a handler unsettled past the threshold, and lowers it on settle', async () => {
    let release!: () => void;
    const settle = new Promise<void>((r) => (release = r));
    render(<WatchHarness settle={settle} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 100);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ADR-0140 Am.1 review F2 — each job has its own clock. FALSIFIED BY HAND: with
  // the old single screen-wide timer, the first `queryByRole` below finds the
  // banner (job A's clock fires 5 s into job B).
  it('a second job gets its own 25 s clock after the first settles', async () => {
    let watch!: ReturnType<typeof useStallWatch>;
    function Overlap() {
      watch = useStallWatch();
      return <StallBanner />;
    }
    render(<Overlap />);
    let releaseA!: () => void;
    let releaseB!: () => void;
    void watch(() => new Promise<void>((r) => (releaseA = r)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    void watch(() => new Promise<void>((r) => (releaseB = r)));
    await act(async () => {
      releaseA();
      await vi.advanceTimersByTimeAsync(10_000); // t=30 s: A's deadline passed, B is 10 s old
    });
    expect(screen.queryByRole('alert'), 'job A’s clock raised the banner over job B').toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS); // B is now 35 s old
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => {
      releaseB();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a stalled first job is not hidden by a second tap, and unmount lowers the banner', async () => {
    let watch!: ReturnType<typeof useStallWatch>;
    function Overlap() {
      watch = useStallWatch();
      return <StallBanner />;
    }
    const events: boolean[] = [];
    const onStall = (e: Event): void => {
      events.push((e as CustomEvent<{ stalled: boolean }>).detail.stalled);
    };
    window.addEventListener('dr3:stall', onStall);
    const { unmount } = render(<Overlap />);
    void watch(() => new Promise<void>(() => {})); // A never settles
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    void watch(() => new Promise<void>(() => {})); // B, 20 s in
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100); // A is past 25 s
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    unmount();
    expect(events).toEqual([true, false]);
    // No orphaned timer re-raises it after the screen is gone.
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS * 2);
    expect(events).toEqual([true, false]);
    window.removeEventListener('dr3:stall', onStall);
  });

  it('a prompt handler never raises it, and a rejecting one still settles', async () => {
    function Rejecter() {
      const watch = useStallWatch();
      useEffect(() => {
        watch(async () => {
          throw new Error('boom');
        }).catch(() => {});
      }, [watch]);
      return <StallBanner />;
    }
    render(<Rejecter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 100);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
