// ADR-0051 — the AP queue page adopts the Vision deep-space theme (was ADR-0008
// green). Smoke test: BOTH the access-denied panel and the approver view paint
// the deep-space base (`bg-dr3-space`), never the legacy `bg-dr3-green-deep`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const currentOpsViewer = vi.fn();
const canActOnApRequest = vi.fn();

vi.mock('@/lib/ops/viewer', () => ({ currentOpsViewer: () => currentOpsViewer() }));
vi.mock('@/lib/ap/approvers', () => ({
  canActOnApRequest: (...a: unknown[]) => canActOnApRequest(...a),
}));
// next/navigation redirect throws (like the real one) so an unauthenticated
// render short-circuits instead of returning markup.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import ApQueuePage from './page';

beforeEach(() => {
  currentOpsViewer.mockReset();
  canActOnApRequest.mockReset();
});

const identity = { userId: 'u-morena', viewer: { role: 'manager' } };

describe('ApQueuePage — deep-space repaint (ADR-0051)', () => {
  it('approver view renders the deep-space base, not the legacy green', async () => {
    currentOpsViewer.mockResolvedValue(identity);
    canActOnApRequest.mockResolvedValue(true);
    const html = renderToStaticMarkup(await ApQueuePage());
    expect(html).toContain('bg-dr3-space');
    expect(html).not.toContain('bg-dr3-green-deep');
    expect(html).toContain('Vendor-invoice approvals');
  });

  it('access-denied panel is also repainted to the deep-space base', async () => {
    currentOpsViewer.mockResolvedValue(identity);
    canActOnApRequest.mockResolvedValue(false);
    const html = renderToStaticMarkup(await ApQueuePage());
    expect(html).toContain('bg-dr3-space');
    expect(html).not.toContain('bg-dr3-green-deep');
    expect(html).toContain('Access denied');
  });
});
