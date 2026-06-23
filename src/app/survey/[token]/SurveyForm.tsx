'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface QuestionPropsBase {
  id: string;
  position: number;
  kind: 'short_text' | 'long_text' | 'single_select' | 'multi_select';
  prompt: string;
  description: string | null;
  options: Array<{ label: string; value: string }> | null;
  is_required: boolean;
}

interface InviteForForm {
  id: string;
  recipient_name: string;
  role_label: string;
  campaign: { title: string; intro_text: string; from_display_name: string };
  questions: QuestionPropsBase[];
  responses: Array<{ question_id: string; answer_text: string | null; answer_json: unknown }>;
  token: string;
}

interface AnswerMap {
  [questionId: string]: { answer_text?: string | undefined; answer_json?: unknown };
}

export function SurveyForm({ invite }: { invite: InviteForForm }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    const init: AnswerMap = {};
    for (const r of invite.responses) {
      init[r.question_id] = {
        answer_text: r.answer_text ?? undefined,
        answer_json: r.answer_json ?? undefined,
      };
    }
    return init;
  });
  const [savingStatus, setSavingStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dirtyRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  function scheduleSave() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void saveDrafts(), 800);
  }

  function setText(qid: string, text: string) {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], answer_text: text } }));
    dirtyRef.current.add(qid);
    scheduleSave();
  }

  function setMulti(qid: string, values: string[]) {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], answer_json: values } }));
    dirtyRef.current.add(qid);
    scheduleSave();
  }

  async function saveDrafts() {
    const dirty = [...dirtyRef.current];
    if (dirty.length === 0) return;
    dirtyRef.current.clear();
    setSavingStatus('saving');
    try {
      const current = answersRef.current;
      const payload = dirty.map((qid) => ({
        question_id: qid,
        answer_text: current[qid]?.answer_text ?? null,
        answer_json: current[qid]?.answer_json ?? null,
      }));
      const r = await fetch(`/api/survey/${invite.token}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: payload }),
      });
      if (!r.ok) throw new Error(`save failed: ${r.status}`);
      setSavingStatus('saved');
      setTimeout(() => setSavingStatus('idle'), 1500);
    } catch {
      setSavingStatus('error');
      dirty.forEach((q) => dirtyRef.current.add(q));
    }
  }

  async function handleSubmit() {
    await saveDrafts();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(`/api/survey/${invite.token}/submit`, { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'unknown' }));
        throw new Error(
          err.error === 'invalid_input'
            ? 'Please answer all required questions.'
            : 'Submission failed. Try again.',
        );
      }
      router.refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  return (
    <main style={{ background: '#f7f3ea', minHeight: '100vh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px 80px' }}>
        <header
          style={{
            background: '#a3151a',
            color: '#fff',
            padding: '20px 24px',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>St. Vincent de Paul · DR3</div>
          <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{invite.campaign.title}</div>
        </header>
        <section
          style={{
            background: '#fff',
            padding: '24px',
            marginTop: 12,
            borderRadius: 6,
            border: '1px solid #e8e2d4',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>
            Hi {invite.recipient_name},
          </p>
          <p style={{ marginTop: 4, fontSize: 13, color: '#666' }}>Role: {invite.role_label}</p>
          <div
            style={{
              marginTop: 16,
              color: '#1a1a1a',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.55,
            }}
          >
            {invite.campaign.intro_text}
          </div>
        </section>
        <ol style={{ listStyle: 'none', padding: 0, marginTop: 24 }}>
          {invite.questions.map((q) => (
            <li
              key={q.id}
              style={{
                background: '#fff',
                padding: '20px 24px',
                marginBottom: 12,
                borderRadius: 6,
                border: '1px solid #e8e2d4',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 12, color: '#999', fontFamily: 'monospace' }}>
                  {q.position}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: '#1a1a1a' }}>
                    {q.prompt}
                    {q.is_required && (
                      <span style={{ color: '#a3151a', marginLeft: 4 }}>*</span>
                    )}
                  </div>
                  {q.description && (
                    <div style={{ marginTop: 4, fontSize: 13, color: '#666' }}>
                      {q.description}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                {q.kind === 'short_text' && (
                  <input
                    type="text"
                    value={answers[q.id]?.answer_text ?? ''}
                    onChange={(e) => setText(q.id, e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: 14,
                      border: '1px solid #d0c8b4',
                      borderRadius: 4,
                    }}
                  />
                )}
                {q.kind === 'long_text' && (
                  <textarea
                    value={answers[q.id]?.answer_text ?? ''}
                    onChange={(e) => setText(q.id, e.target.value)}
                    rows={6}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      fontSize: 14,
                      border: '1px solid #d0c8b4',
                      borderRadius: 4,
                      fontFamily: 'inherit',
                      resize: 'vertical',
                    }}
                  />
                )}
                {q.kind === 'single_select' && q.options && (
                  <div>
                    {q.options.map((opt) => (
                      <label
                        key={opt.value}
                        style={{ display: 'block', padding: '4px 0', cursor: 'pointer' }}
                      >
                        <input
                          type="radio"
                          name={q.id}
                          value={opt.value}
                          checked={answers[q.id]?.answer_text === opt.value}
                          onChange={() => setText(q.id, opt.value)}
                          style={{ marginRight: 8 }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === 'multi_select' && q.options && (
                  <div>
                    {q.options.map((opt) => {
                      const current = (answers[q.id]?.answer_json as string[]) ?? [];
                      const checked = current.includes(opt.value);
                      return (
                        <label
                          key={opt.value}
                          style={{ display: 'block', padding: '4px 0', cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...current, opt.value]
                                : current.filter((v) => v !== opt.value);
                              setMulti(q.id, next);
                            }}
                            style={{ marginRight: 8 }}
                          />
                          {opt.label}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div
          style={{
            background: '#fff',
            padding: 20,
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 12, color: '#888' }}>
            {savingStatus === 'saving' && 'Saving…'}
            {savingStatus === 'saved' && 'Draft saved ✓'}
            {savingStatus === 'error' && (
              <span style={{ color: '#a3151a' }}>Save error — will retry</span>
            )}
            {savingStatus === 'idle' && 'Draft auto-saves as you type'}
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              background: '#a3151a',
              color: '#fff',
              padding: '10px 24px',
              border: 'none',
              borderRadius: 4,
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Submitting…' : 'Submit responses'}
          </button>
        </div>
        {submitError && (
          <p style={{ marginTop: 12, color: '#a3151a', fontSize: 13 }}>{submitError}</p>
        )}
      </div>
    </main>
  );
}
