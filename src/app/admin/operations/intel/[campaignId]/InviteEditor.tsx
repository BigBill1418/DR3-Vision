'use client';

// ADR-0034 — Invite metadata + question-packet editor.
//
// Editing questions on an `approved` invite resets it to `draft` server-side
// (updateInviteQuestions) — the caller refreshes to reflect that. No HTML
// <form> tags; saves on a button onClick (CLAUDE.md hard rule).

import { useState } from 'react';
import type { getCampaignWithInvites } from '@/lib/survey/campaigns';

type Campaign = NonNullable<Awaited<ReturnType<typeof getCampaignWithInvites>>>;
type Invite = Campaign['invites'][number];

type QuestionKind = 'short_text' | 'long_text' | 'single_select' | 'multi_select';

interface EditableQuestion {
  position: number;
  kind: QuestionKind;
  prompt: string;
  description: string | null;
  options: Array<{ label: string; value: string }> | null;
  is_required: boolean;
}

const KINDS: QuestionKind[] = ['short_text', 'long_text', 'single_select', 'multi_select'];

function toEditable(invite: Invite): EditableQuestion[] {
  return invite.questions.map((q) => ({
    position: q.position,
    kind: q.kind as QuestionKind,
    prompt: q.prompt,
    description: q.description,
    options: (q.options as Array<{ label: string; value: string }> | null) ?? null,
    is_required: q.is_required,
  }));
}

export function InviteEditor({
  campaignId,
  invite,
  onClose,
  onSaved,
}: {
  campaignId: string;
  invite: Invite;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editable = invite.status === 'draft' || invite.status === 'approved';
  const [questions, setQuestions] = useState<EditableQuestion[]>(() => toEditable(invite));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function renumber(list: EditableQuestion[]): EditableQuestion[] {
    return list.map((q, i) => ({ ...q, position: i + 1 }));
  }

  function updateQuestion(idx: number, patch: Partial<EditableQuestion>) {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  }

  function addQuestion() {
    setQuestions((prev) =>
      renumber([
        ...prev,
        {
          position: prev.length + 1,
          kind: 'long_text',
          prompt: '',
          description: null,
          options: null,
          is_required: false,
        },
      ]),
    );
  }

  function removeQuestion(idx: number) {
    setQuestions((prev) => renumber(prev.filter((_, i) => i !== idx)));
  }

  function move(idx: number, delta: number) {
    setQuestions((prev) => {
      const next = [...prev];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return prev;
      const a = next[idx];
      const b = next[target];
      if (!a || !b) return prev;
      next[idx] = b;
      next[target] = a;
      return renumber(next);
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        questions: questions.map((q) => ({
          position: q.position,
          kind: q.kind,
          prompt: q.prompt,
          description: q.description,
          options:
            q.kind === 'single_select' || q.kind === 'multi_select' ? q.options ?? [] : null,
          is_required: q.is_required,
        })),
      };
      const r = await fetch(
        `/api/admin/operations/intel/campaigns/${campaignId}/invites/${invite.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `save failed: ${r.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
      setSaving(false);
    }
  }

  return (
    <ModalShell onClose={() => !saving && onClose()}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 200 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>{invite.recipient_name}</h2>
          <div style={{ fontSize: 13, color: '#666' }}>{invite.recipient_email}</div>
          <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>{invite.role_label}</div>
          <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>Status: {invite.status}</div>
          {!editable && (
            <div style={{ fontSize: 12, color: '#a3151a', marginTop: 8 }}>
              Questions are locked once the invite has been sent.
            </div>
          )}
          {invite.status === 'approved' && (
            <div style={{ fontSize: 12, color: '#a3151a', marginTop: 8 }}>
              Saving question changes will reset this invite to draft (re-preview + re-approve).
            </div>
          )}
        </div>

        <div style={{ flex: '2 1 360px', minWidth: 320 }}>
          {questions.map((q, idx) => (
            <div
              key={idx}
              style={{
                border: '1px solid #e8e2d4',
                borderRadius: 6,
                padding: 14,
                marginBottom: 10,
                background: '#fbf9f4',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#999' }}>
                  {q.position}
                </span>
                <select
                  value={q.kind}
                  disabled={!editable}
                  onChange={(e) => updateQuestion(idx, { kind: e.target.value as QuestionKind })}
                  style={{ fontSize: 13, padding: '3px 6px' }}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <label style={{ fontSize: 12, color: '#555', marginLeft: 'auto' }}>
                  <input
                    type="checkbox"
                    checked={q.is_required}
                    disabled={!editable}
                    onChange={(e) => updateQuestion(idx, { is_required: e.target.checked })}
                    style={{ marginRight: 4 }}
                  />
                  required
                </label>
              </div>
              <input
                type="text"
                value={q.prompt}
                disabled={!editable}
                placeholder="Prompt"
                onChange={(e) => updateQuestion(idx, { prompt: e.target.value })}
                style={inputStyle}
              />
              <input
                type="text"
                value={q.description ?? ''}
                disabled={!editable}
                placeholder="Description (optional)"
                onChange={(e) =>
                  updateQuestion(idx, { description: e.target.value === '' ? null : e.target.value })
                }
                style={{ ...inputStyle, marginTop: 6 }}
              />
              {(q.kind === 'single_select' || q.kind === 'multi_select') && (
                <textarea
                  value={(q.options ?? []).map((o) => `${o.label}|${o.value}`).join('\n')}
                  disabled={!editable}
                  placeholder="One option per line: Label|value"
                  rows={3}
                  onChange={(e) =>
                    updateQuestion(idx, {
                      options: e.target.value
                        .split('\n')
                        .map((line) => line.trim())
                        .filter((line) => line !== '')
                        .map((line) => {
                          const [label, value] = line.split('|');
                          return { label: label ?? line, value: (value ?? label ?? line).trim() };
                        }),
                    })
                  }
                  style={{ ...inputStyle, marginTop: 6, fontFamily: 'monospace', resize: 'vertical' }}
                />
              )}
              {editable && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" onClick={() => move(idx, -1)} style={miniBtn}>
                    ↑
                  </button>
                  <button type="button" onClick={() => move(idx, 1)} style={miniBtn}>
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQuestion(idx)}
                    style={{ ...miniBtn, color: '#a3151a' }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}

          {editable && (
            <button type="button" onClick={addQuestion} style={cancelStyle}>
              + Add question
            </button>
          )}
        </div>
      </div>

      {error && <div style={{ color: '#a3151a', fontSize: 13, marginTop: 12 }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" onClick={() => !saving && onClose()} style={cancelStyle}>
          Cancel
        </button>
        {editable && (
          <button
            type="button"
            onClick={save}
            disabled={saving || questions.length === 0}
            style={{
              ...primaryStyle,
              cursor: saving || questions.length === 0 ? 'not-allowed' : 'pointer',
              opacity: saving || questions.length === 0 ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save questions'}
          </button>
        )}
      </div>
    </ModalShell>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 6,
          border: '1px solid #e8e2d4',
          width: '100%',
          maxWidth: 820,
          padding: 24,
        }}
      >
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  border: '1px solid #d0c8b4',
  borderRadius: 4,
  boxSizing: 'border-box',
};

const cancelStyle: React.CSSProperties = {
  background: '#fff',
  color: '#555',
  padding: '8px 14px',
  border: '1px solid #d0c8b4',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};

const primaryStyle: React.CSSProperties = {
  background: '#a3151a',
  color: '#fff',
  padding: '8px 16px',
  border: 'none',
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
};

const miniBtn: React.CSSProperties = {
  background: '#fff',
  color: '#555',
  padding: '4px 10px',
  border: '1px solid #d0c8b4',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
