// Audit 2026-07-16 RES — call-site smoke for the AP stamp renderer, the one
// real Chromium launch site with an exported entrypoint (the payroll/COR
// renderers are module-internal and share the identical `withChromium` wrap;
// their gate behaviour is proven in chromium-semaphore.test.ts). Playwright is
// mocked so no real browser launches: we hold one render "in flight" and assert
// the overlapping render does NOT launch a second browser until the first frees
// the shared slot — and that each call still yields a %PDF buffer.

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  launchCount: 0,
  closeCount: 0,
  // Resolvers for each parked `page.pdf()` call, in launch order.
  pdfResolvers: [] as Array<() => void>,
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      h.launchCount += 1;
      return {
        newPage: async () => ({
          route: async () => {},
          setContent: async () => {},
          // Park until the test releases us, so a render can be held in flight.
          pdf: () =>
            new Promise<Buffer>((resolve) => {
              h.pdfResolvers.push(() => resolve(Buffer.from('%PDF-1.4 fake')));
            }),
        }),
        close: async () => {
          h.closeCount += 1;
        },
      };
    },
  },
}));

import { defaultPlaywrightRenderer } from './stamp';
import { chromiumSemaphore } from '@/lib/chromium-semaphore';

// Drain across macrotasks — the renderer resolves `await import('playwright')`
// (a real dynamic import) before it launches, which microtask ticks alone miss.
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('defaultPlaywrightRenderer — serialized by the shared Chromium gate', () => {
  it('holds the slot for one render and queues the next, still returning PDFs', async () => {
    const a = defaultPlaywrightRenderer('<html>A</html>');
    const b = defaultPlaywrightRenderer('<html>B</html>');

    await flush();
    // A launched and is parked in pdf(); B is queued behind the gate.
    expect(h.launchCount).toBe(1);
    expect(chromiumSemaphore.pending).toBe(1);

    // Release A → it closes and frees the slot → B may now launch.
    h.pdfResolvers.shift()?.();
    await flush();
    expect(h.launchCount).toBe(2);
    expect(h.closeCount).toBe(1);

    h.pdfResolvers.shift()?.();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(rb.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(h.closeCount).toBe(2);
    expect(chromiumSemaphore.pending).toBe(0);
  });
});
