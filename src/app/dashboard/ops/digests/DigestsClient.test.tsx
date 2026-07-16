// @vitest-environment jsdom
//
// audit 2026-07-16 · IFRAME — the digest preview iframe renders server-built HTML
// via srcDoc and MUST carry sandbox="" (no scripts, no same-origin) so a future
// edit can't turn it into a stored-XSS surface. Drives the component into its
// selected state (list → open detail) and asserts the attribute is present.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DigestsClient } from './DigestsClient';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonRes(obj: unknown) {
  return { ok: true, status: 200, json: async () => obj } as unknown as Response;
}

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function flush() {
  // Let the mount effect + click-triggered fetch chains settle.
  for (let i = 0; i < 5; i++) await act(async () => {});
}

describe('DigestsClient preview iframe', () => {
  it('renders the preview iframe with sandbox="" once a digest is opened', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/ops/digests') {
        return jsonRes({
          rows: [
            {
              id: 'd1',
              kind: 'weekly',
              period_start: '2026-07-01',
              period_end: '2026-07-07',
              status: 'draft',
              finalized_at: null,
            },
          ],
        });
      }
      if (url === '/api/ops/digests/d1') {
        return jsonRes({
          digest: {
            id: 'd1',
            kind: 'weekly',
            period_start: '2026-07-01',
            period_end: '2026-07-07',
            status: 'draft',
            body_md: '# hi',
          },
          html: '<b>preview body</b>',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<DigestsClient />);
    });
    await flush();

    const openBtn = container.querySelector('aside button') as HTMLButtonElement | null;
    expect(openBtn).not.toBeNull();
    await act(async () => {
      openBtn!.click();
    });
    await flush();

    const iframe = container.querySelector('iframe[title="digest preview"]') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.hasAttribute('sandbox')).toBe(true);
    expect(iframe.getAttribute('sandbox')).toBe('');
  });
});
