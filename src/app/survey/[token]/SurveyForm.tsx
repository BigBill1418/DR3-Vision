'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

// A required question is satisfied when it carries a non-empty text answer OR a
// non-empty json (multi-select) answer — mirrors submitResponse() server-side so
// client validation never diverges from the server gate.
function isAnswered(q: QuestionPropsBase, a: AnswerMap[string] | undefined): boolean {
  // A select question with no configured options is unanswerable (a packet-
  // authoring slip). Don't trap the respondent on it — treat as satisfied; the
  // empty-state below tells them to flag it. The editor now blocks creating one.
  if ((q.kind === 'single_select' || q.kind === 'multi_select') && (q.options?.length ?? 0) === 0) {
    return true;
  }
  if (!a) return false;
  if (q.kind === 'multi_select') {
    return Array.isArray(a.answer_json) && (a.answer_json as unknown[]).length > 0;
  }
  return typeof a.answer_text === 'string' && a.answer_text.trim() !== '';
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
  const [savingStatus, setSavingStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Question ids that failed required-field validation on the last submit
  // attempt. Cleared per-question as the respondent fills them in.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const dirtyRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const questionRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const requiredQuestions = useMemo(
    () => invite.questions.filter((q) => q.is_required),
    [invite.questions],
  );

  function scheduleSave() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void saveDrafts(), 800);
  }

  function clearMissing(qid: string) {
    setMissing((prev) => {
      if (!prev.has(qid)) return prev;
      const next = new Set(prev);
      next.delete(qid);
      return next;
    });
  }

  function setText(qid: string, text: string) {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], answer_text: text } }));
    dirtyRef.current.add(qid);
    clearMissing(qid);
    scheduleSave();
  }

  function setMulti(qid: string, values: string[]) {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], answer_json: values } }));
    dirtyRef.current.add(qid);
    if (values.length > 0) clearMissing(qid);
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

  // Returns the set of unanswered required-question ids (empty = all satisfied).
  function validateRequired(): Set<string> {
    const current = answersRef.current;
    const gaps = new Set<string>();
    for (const q of requiredQuestions) {
      if (!isAnswered(q, current[q.id])) gaps.add(q.id);
    }
    return gaps;
  }

  function attemptSubmit() {
    setSubmitError(null);
    const gaps = validateRequired();
    if (gaps.size > 0) {
      setMissing(gaps);
      // Scroll the first unanswered required question into view + focus it.
      const firstId = invite.questions.find((q) => gaps.has(q.id))?.id;
      if (firstId) {
        const el = questionRefs.current[firstId];
        if (typeof el?.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        el?.querySelector<HTMLElement>('input,textarea')?.focus({ preventScroll: true });
      }
      setSubmitError(
        `Please answer ${gaps.size} required ${gaps.size === 1 ? 'question' : 'questions'} (marked below) before submitting.`,
      );
      return;
    }
    setConfirming(true);
  }

  async function doSubmit() {
    setConfirming(false);
    // Flush any pending debounced draft before locking.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    await saveDrafts();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(`/api/survey/${invite.token}/submit`, { method: 'POST' });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({ error: 'unknown' }))) as { error?: string };
        if (err.error === 'invalid_input') {
          // Server-side gate caught something the client missed — re-mark.
          setMissing(validateRequired());
          throw new Error('Please answer all required questions (marked below).');
        }
        if (err.error === 'already_submitted') {
          // Someone already locked this invite — refresh into the thank-you view.
          router.refresh();
          return;
        }
        throw new Error('Submission failed. Please try again.');
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
    <main
      style={{ background: '#f7f3ea', minHeight: '100vh', color: '#1a1a1a', colorScheme: 'light' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px 96px' }}>
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
          <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>Hi {invite.recipient_name},</p>
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
          <p style={{ marginTop: 16, fontSize: 12, color: '#888' }}>
            Questions marked <span style={{ color: '#a3151a' }}>*</span> are required. Your answers
            save automatically as you type — you can close this page and come back to finish later.
          </p>
        </section>
        <ol style={{ listStyle: 'none', padding: 0, marginTop: 24 }}>
          {invite.questions.map((q) => {
            const isMissing = missing.has(q.id);
            const promptId = `q-${q.id}-prompt`;
            const descId = q.description ? `q-${q.id}-desc` : undefined;
            const hasOptions =
              q.kind === 'single_select' || q.kind === 'multi_select'
                ? (q.options?.length ?? 0) > 0
                : true;
            return (
              <li
                key={q.id}
                ref={(el) => {
                  questionRefs.current[q.id] = el;
                }}
                style={{
                  background: '#fff',
                  padding: '20px 24px',
                  marginBottom: 12,
                  borderRadius: 6,
                  border: isMissing ? '1px solid #a3151a' : '1px solid #e8e2d4',
                  boxShadow: isMissing ? '0 0 0 3px rgba(163,21,26,0.10)' : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ fontSize: 12, color: '#999', fontFamily: 'monospace' }}>
                    {q.position}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div id={promptId} style={{ fontWeight: 600, fontSize: 15, color: '#1a1a1a' }}>
                      {q.prompt}
                      {q.is_required && (
                        <span style={{ color: '#a3151a', marginLeft: 4 }} aria-hidden="true">
                          *
                        </span>
                      )}
                      {q.is_required && (
                        <span
                          style={{
                            position: 'absolute',
                            width: 1,
                            height: 1,
                            overflow: 'hidden',
                            clip: 'rect(0 0 0 0)',
                          }}
                        >
                          (required)
                        </span>
                      )}
                    </div>
                    {q.description && (
                      <div id={descId} style={{ marginTop: 4, fontSize: 13, color: '#666' }}>
                        {q.description}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  {q.kind === 'short_text' && (
                    <input
                      type="text"
                      aria-labelledby={promptId}
                      aria-describedby={descId}
                      aria-required={q.is_required}
                      aria-invalid={isMissing}
                      value={answers[q.id]?.answer_text ?? ''}
                      onChange={(e) => setText(q.id, e.target.value)}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        fontSize: 16,
                        color: '#1a1a1a',
                        WebkitTextFillColor: '#1a1a1a',
                        background: '#fff',
                        colorScheme: 'light',
                        border: `1px solid ${isMissing ? '#a3151a' : '#d0c8b4'}`,
                        borderRadius: 4,
                        boxSizing: 'border-box',
                      }}
                    />
                  )}
                  {q.kind === 'long_text' && (
                    <textarea
                      aria-labelledby={promptId}
                      aria-describedby={descId}
                      aria-required={q.is_required}
                      aria-invalid={isMissing}
                      value={answers[q.id]?.answer_text ?? ''}
                      onChange={(e) => setText(q.id, e.target.value)}
                      rows={6}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        fontSize: 16,
                        color: '#1a1a1a',
                        WebkitTextFillColor: '#1a1a1a',
                        background: '#fff',
                        colorScheme: 'light',
                        border: `1px solid ${isMissing ? '#a3151a' : '#d0c8b4'}`,
                        borderRadius: 4,
                        fontFamily: 'inherit',
                        resize: 'vertical',
                        boxSizing: 'border-box',
                      }}
                    />
                  )}
                  {q.kind === 'single_select' &&
                    (hasOptions ? (
                      <div role="radiogroup" aria-labelledby={promptId} aria-describedby={descId}>
                        {q.options!.map((opt) => (
                          <label
                            key={opt.value}
                            style={{ display: 'block', padding: '6px 0', cursor: 'pointer' }}
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
                    ) : (
                      <NoOptions />
                    ))}
                  {q.kind === 'multi_select' &&
                    (hasOptions ? (
                      <div role="group" aria-labelledby={promptId} aria-describedby={descId}>
                        {q.options!.map((opt) => {
                          const current = (answers[q.id]?.answer_json as string[]) ?? [];
                          const checked = current.includes(opt.value);
                          return (
                            <label
                              key={opt.value}
                              style={{ display: 'block', padding: '6px 0', cursor: 'pointer' }}
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
                    ) : (
                      <NoOptions />
                    ))}
                </div>
                {isMissing && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#a3151a' }}>
                    This question is required.
                  </div>
                )}
              </li>
            );
          })}
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
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 12, color: '#888' }} aria-live="polite">
            {savingStatus === 'saving' && 'Saving…'}
            {savingStatus === 'saved' && 'Draft saved ✓'}
            {savingStatus === 'error' && (
              <span style={{ color: '#a3151a' }}>Save error — will retry</span>
            )}
            {savingStatus === 'idle' && 'Draft auto-saves as you type'}
          </div>
          <button
            type="button"
            onClick={attemptSubmit}
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
          <p
            role="alert"
            style={{
              marginTop: 12,
              color: '#a3151a',
              fontSize: 13,
              background: '#fff',
              border: '1px solid #a3151a',
              borderRadius: 4,
              padding: '10px 12px',
            }}
          >
            {submitError}
          </p>
        )}
      </div>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="submit-confirm-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => setConfirming(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 6,
              border: '1px solid #e8e2d4',
              padding: 24,
              maxWidth: 440,
              width: '100%',
            }}
          >
            <h2 id="submit-confirm-title" style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>
              Submit your responses?
            </h2>
            <p style={{ fontSize: 14, color: '#555', lineHeight: 1.5 }}>
              Once submitted, your answers are locked and you won&apos;t be able to edit them. If
              you need to change something later, reply to Bill&apos;s email and he can reopen your
              survey.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                style={{
                  background: '#fff',
                  color: '#555',
                  padding: '9px 16px',
                  border: '1px solid #d0c8b4',
                  borderRadius: 4,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={doSubmit}
                style={{
                  background: '#a3151a',
                  color: '#fff',
                  padding: '9px 16px',
                  border: 'none',
                  borderRadius: 4,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Submit responses
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// Shown when a select question reaches the respondent with no options configured
// (a packet-authoring slip). Keeps the survey usable instead of a blank gap.
function NoOptions() {
  return (
    <div
      style={{
        fontSize: 13,
        color: '#a3151a',
        background: '#fbf2f2',
        border: '1px solid #e7c9c9',
        borderRadius: 4,
        padding: '8px 10px',
      }}
    >
      No answer choices are configured for this question yet. You can skip it — please mention it in
      your reply to Bill so it can be fixed.
    </div>
  );
}
