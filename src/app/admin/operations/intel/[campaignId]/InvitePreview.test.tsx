// @vitest-environment jsdom
//
// audit 2026-07-16 · IFRAME — the invite email-preview iframe renders the
// server-built email HTML via srcDoc and MUST carry sandbox="" (no scripts, no
// same-origin). Mounts the component (email tab is default), lets the preview
// fetch settle, and asserts the attribute is present.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InvitePreview } from './InvitePreview';

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
  for (let i = 0; i < 5; i++) await act(async () => {});
}

// Minimal invite shaped enough for the component; cast through unknown since the
// full Prisma-derived type is not needed to exercise the render path.
const invite = {
  id: 'inv-1',
  recipient_name: 'Rick',
  status: 'draft',
  token: 'tok-123',
  questions: [],
  approved_by: null,
  approved_at: null,
} as unknown as Parameters<typeof InvitePreview>[0]['invite'];

describe('InvitePreview email iframe', () => {
  it('renders the email-preview iframe with sandbox=""', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonRes({
        preview: {
          subject: 'Hi',
          from_address: 'a@svdp.us',
          from_display_name: 'Bill',
          reply_to: 'r@svdp.us',
          to_email: 'rick@x.com',
          to_name: 'Rick',
          html_body: '<b>email body</b>',
        },
      }),
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <InvitePreview
          campaignId="camp-1"
          invite={invite}
          onClose={() => {}}
          onEdit={() => {}}
          onChanged={() => {}}
        />,
      );
    });
    await flush();

    const iframe = container.querySelector('iframe[title="email-preview"]') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.hasAttribute('sandbox')).toBe(true);
    expect(iframe.getAttribute('sandbox')).toBe('');
  });
});
