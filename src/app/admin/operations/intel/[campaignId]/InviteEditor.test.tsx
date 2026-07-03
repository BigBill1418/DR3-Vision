// @vitest-environment jsdom
//
// ADR-0034 — InviteEditor validation guards (Sprint 6 launch hardening).
//
// The server contract requires every question to carry a non-empty prompt and
// every select kind to carry >= 1 option. Before this guard the editor would
// POST an invalid packet and surface a bare "save failed: 422". These tests pin
// the client-side validation: an invalid packet is BLOCKED (no PATCH) with an
// inline message; a valid packet PATCHes through.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InviteEditor } from './InviteEditor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

function clickButton(label: string) {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`button "${label}" not found`);
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

// Minimal invite shaped like getCampaignWithInvites().invites[number].
function inviteWith(kind: string, prompt: string, options: unknown) {
  return {
    id: 'inv-1',
    recipient_name: 'Juan',
    recipient_email: 'juan@example.org',
    role_label: 'Warehouse',
    status: 'draft',
    token: 'tok',
    approved_by: null,
    approved_at: null,
    questions: [
      {
        id: 'q1',
        invite_id: 'inv-1',
        position: 1,
        kind,
        prompt,
        description: null,
        options,
        is_required: false,
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('InviteEditor save validation', () => {
  it('blocks save when a question prompt is empty — no PATCH fires', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(
      <InviteEditor
        campaignId="c1"
        invite={inviteWith('long_text', '', null)}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    clickButton('Save questions');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent ?? '').toMatch(/Prompt is required/i);
  });

  it('blocks save when a select question has no options — no PATCH fires', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(
      <InviteEditor
        campaignId="c1"
        invite={inviteWith('single_select', 'Pick one', [])}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    clickButton('Save questions');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent ?? '').toMatch(/at least one answer option/i);
  });

  it('PATCHes a valid packet', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    mount(
      <InviteEditor
        campaignId="c1"
        invite={inviteWith('long_text', 'What works?', null)}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    clickButton('Save questions');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/operations/intel/campaigns/c1/invites/inv-1');
    expect(opts.method).toBe('PATCH');
  });
});
