'use client';

// ADR-0034 — Send confirmation interstitial.
//
// Three states: confirm (type the campaign title to arm the Send button),
// in-progress, completed. POSTs { confirmed_recipient_count } — the server
// refuses with 422 count_diverged if the approved-count moved.

import { useState } from 'react';
import type { getCampaignWithInvites } from '@/lib/survey/campaigns';

type Campaign = NonNullable<Awaited<ReturnType<typeof getCampaignWithInvites>>>;
type Invite = Campaign['invites'][number];

interface SendResult {
  invite_id: string;
  recipient_name: string;
  delivered: boolean;
  last_status: number | null;
  error?: string;
}

export function SendInterstitial({
  campaignId,
  campaignTitle,
  approvedInvites,
  onClose,
  onDone,
}: {
  campaignId: string;
  campaignTitle: string;
  approvedInvites: Invite[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<'confirm' | 'sending' | 'done'>('confirm');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SendResult[]>([]);

  const count = approvedInvites.length;
  const armed = typed.trim() === campaignTitle.trim() && count > 0;

  async function send() {
    if (!armed) return;
    setPhase('sending');
    setError(null);
    try {
      const r = await fetch(`/api/admin/operations/intel/campaigns/${campaignId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed_recipient_count: count }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        expected?: number;
        provided?: number;
        results?: SendResult[];
      };
      if (!r.ok) {
        if (body.error === 'count_diverged') {
          throw new Error(
            `Approved count changed (expected ${body.expected}, you confirmed ${body.provided}). Reopen and try again.`,
          );
        }
        throw new Error(body.error ?? `send failed: ${r.status}`);
      }
      setResults(body.results ?? []);
      setPhase('done');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'send failed');
      setPhase('confirm');
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
        zIndex: 50,
      }}
      onClick={() => phase !== 'sending' && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 6,
          border: '1px solid #e8e2d4',
          width: '100%',
          maxWidth: 520,
          padding: 24,
        }}
      >
        {phase === 'confirm' && (
          <>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>Send campaign</h2>
            <p style={{ fontSize: 15, color: '#1a1a1a' }}>
              <strong>
                You are about to send {count} {count === 1 ? 'email' : 'emails'} to {count}{' '}
                {count === 1 ? 'recipient' : 'recipients'}.
              </strong>
            </p>
            <ul style={{ fontSize: 13, color: '#555', paddingLeft: 18, maxHeight: 180, overflowY: 'auto' }}>
              {approvedInvites.map((i) => (
                <li key={i.id}>
                  {i.recipient_name} — {i.recipient_email} ({i.role_label})
                </li>
              ))}
            </ul>
            <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 12 }}>
              Type the campaign title to confirm: <em>{campaignTitle}</em>
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 14,
                border: '1px solid #d0c8b4',
                borderRadius: 4,
                boxSizing: 'border-box',
                marginTop: 4,
              }}
            />
            {error && <div style={{ color: '#a3151a', fontSize: 13, marginTop: 12 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button type="button" onClick={onClose} style={cancelStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={!armed}
                style={{
                  ...primaryStyle,
                  cursor: armed ? 'pointer' : 'not-allowed',
                  opacity: armed ? 1 : 0.6,
                }}
              >
                Send {count} {count === 1 ? 'email' : 'emails'}
              </button>
            </div>
          </>
        )}

        {phase === 'sending' && (
          <>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>Sending…</h2>
            <ul style={{ fontSize: 13, color: '#555', paddingLeft: 18 }}>
              {approvedInvites.map((i) => (
                <li key={i.id}>{i.recipient_name} — sending…</li>
              ))}
            </ul>
          </>
        )}

        {phase === 'done' && (
          <>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>Send complete</h2>
            <ul style={{ fontSize: 13, color: '#555', paddingLeft: 18 }}>
              {results.map((r) => (
                <li key={r.invite_id} style={{ color: r.delivered ? '#1c7c3b' : '#a3151a' }}>
                  {r.recipient_name} — {r.delivered ? '✓ sent' : `✗ ${r.error ?? 'not delivered'}`}
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 12, color: '#888' }}>
              Any failed recipients stay approved and can be retried with Send again.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={onClose} style={primaryStyle}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const cancelStyle: React.CSSProperties = {
  background: '#fff',
  color: '#555',
  padding: '9px 16px',
  border: '1px solid #d0c8b4',
  borderRadius: 4,
  fontSize: 14,
  cursor: 'pointer',
};

const primaryStyle: React.CSSProperties = {
  background: '#a3151a',
  color: '#fff',
  padding: '9px 16px',
  border: 'none',
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};
