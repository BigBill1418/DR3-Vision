// @vitest-environment jsdom
//
// ADR-0034 — public survey form behavior guards (Sprint 6 launch hardening).
//
// Covers the launch-blocking UX contracts:
//   1. submitting with an unanswered REQUIRED question is blocked client-side
//      (no /submit call) and the question is marked — the respondent is never
//      bounced to a bare server 422;
//   2. when all required questions are answered, Submit opens a confirmation
//      step (irreversible-action guard) and only the confirm fires /submit;
//   3. a select question that reached the respondent with NO options renders a
//      visible empty-state instead of a blank gap, and does NOT trap the
//      required-field gate (unanswerable → not blocking).

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SurveyForm } from './SurveyForm';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  refresh.mockReset();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

interface Q {
  id: string;
  position: number;
  kind: 'short_text' | 'long_text' | 'single_select' | 'multi_select';
  prompt: string;
  description: string | null;
  options: Array<{ label: string; value: string }> | null;
  is_required: boolean;
}

function invite(questions: Q[], responses: Array<{ question_id: string; answer_text: string | null; answer_json: unknown }> = []) {
  return {
    id: 'inv-1',
    recipient_name: 'Juan',
    role_label: 'Warehouse',
    campaign: { title: 'DR3 Intel', intro_text: 'intro', from_display_name: 'Bill' },
    questions,
    responses,
    token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
}

function clickButton(label: string) {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`button "${label}" not found`);
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('SurveyForm required-field validation', () => {
  it('blocks submit and marks the question when a required answer is missing — never calls /submit', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(
      <SurveyForm
        invite={invite([
          {
            id: 'q1',
            position: 1,
            kind: 'long_text',
            prompt: 'What works?',
            description: null,
            options: null,
            is_required: true,
          },
        ])}
      />,
    );

    clickButton('Submit responses');

    // No network submit fired.
    expect(fetchMock).not.toHaveBeenCalled();
    // An alert surfaced and the textarea is marked invalid.
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toMatch(/required/i);
    expect(container.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('opens a confirmation step when all required questions are answered; only confirm fires /submit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    mount(
      <SurveyForm
        invite={invite(
          [
            {
              id: 'q1',
              position: 1,
              kind: 'long_text',
              prompt: 'What works?',
              description: null,
              options: null,
              is_required: true,
            },
          ],
          [{ question_id: 'q1', answer_text: 'a lot', answer_json: null }],
        )}
      />,
    );

    clickButton('Submit responses');
    // Confirmation dialog shown; no submit yet.
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/submit'))).toBe(false);

    // Confirm inside the dialog specifically (the page button shares the label).
    const confirmBtn = [...dialog!.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').includes('Submit responses'),
    ) as HTMLButtonElement;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/submit'))).toBe(true);
  });

  it('renders an empty-state for a no-option select and does NOT block submit on it', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    mount(
      <SurveyForm
        invite={invite([
          {
            id: 'q1',
            position: 1,
            kind: 'single_select',
            prompt: 'Pick one',
            description: null,
            options: [],
            is_required: true,
          },
        ])}
      />,
    );

    // Visible empty-state, not a blank gap.
    expect(container.textContent ?? '').toMatch(/No answer choices are configured/i);
    // Submitting opens the confirm dialog (not blocked) since the question is unanswerable.
    clickButton('Submit responses');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
