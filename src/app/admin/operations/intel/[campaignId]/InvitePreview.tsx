'use client';

// ADR-0034 — Invite preview + per-invite approval gate.
//
// Two tabs: the EXACT email HTML the recipient receives (from the /preview
// route) and the survey page itself (iframe of /survey/{token}?preview=1).
// Approve flips the invite to `approved`; while approved a "Revoke approval"
// button PATCHes the questions back (which resets to draft).

import { useEffect, useState } from 'react';
import type { getCampaignWithInvites } from '@/lib/survey/campaigns';

type Campaign = NonNullable<Awaited<ReturnType<typeof getCampaignWithInvites>>>;
type Invite = Campaign['invites'][number];

interface PreviewPayload {
  subject: string;
  from_address: string;
  from_display_name: string;
  reply_to: string;
  to_email: string;
  to_name: string;
  html_body: string;
}

export function InvitePreview({
  campaignId,
  invite,
  onClose,
  onEdit,
  onChanged,
}: {
  campaignId: string;
  invite: Invite;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'email' | 'survey'>('email');
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvedBanner, setApprovedBanner] = useState(invite.status === 'approved');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/admin/operations/intel/campaigns/${campaignId}/invites/${invite.id}/preview`,
          { method: 'POST' },
        );
        if (!r.ok) throw new Error(`preview failed: ${r.status}`);
        const body = (await r.json()) as { preview: PreviewPayload };
        if (!cancelled) setPreview(body.preview);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'preview failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, invite.id]);

  async function approve() {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/admin/operations/intel/campaigns/${campaignId}/invites/${invite.id}/approve`,
        { method: 'POST' },
      );
      if (!r.ok) throw new Error(`approve failed: ${r.status}`);
      setApprovedBanner(true);
      onChanged();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    // Re-PATCHing the current questions resets an approved invite to draft.
    setBusy(true);
    try {
      const r = await fetch(
        `/api/admin/operations/intel/campaigns/${campaignId}/invites/${invite.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questions: invite.questions.map((q) => ({
              position: q.position,
              kind: q.kind,
              prompt: q.prompt,
              description: q.description,
              options: q.options ?? null,
              is_required: q.is_required,
            })),
          }),
        },
      );
      if (!r.ok) throw new Error(`revoke failed: ${r.status}`);
      setApprovedBanner(false);
      onChanged();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'revoke failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '24px 16px',
        overflowY: 'auto',
        zIndex: 50,
      }}
      onClick={() => !busy && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 6,
          border: '1px solid #e8e2d4',
          width: '100%',
          maxWidth: 720,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: '#1a1a1a' }}>
            Preview — {invite.recipient_name}
          </h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => setTab('email')}
              style={tab === 'email' ? tabActive : tabInactive}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => setTab('survey')}
              style={tab === 'survey' ? tabActive : tabInactive}
            >
              Survey page
            </button>
          </div>
        </div>

        {approvedBanner && (
          <div
            style={{
              background: '#e3f4e8',
              color: '#1c7c3b',
              padding: '8px 12px',
              borderRadius: 4,
              fontSize: 13,
              marginTop: 12,
            }}
          >
            Approved{invite.approved_by ? ` by ${invite.approved_by.name}` : ''}
            {invite.approved_at ? ` at ${new Date(invite.approved_at).toISOString().slice(0, 16)} UTC` : ''}
          </div>
        )}

        {loadError && (
          <div style={{ color: '#a3151a', fontSize: 13, marginTop: 12 }}>{loadError}</div>
        )}

        {tab === 'email' && (
          <div style={{ marginTop: 12 }}>
            {preview ? (
              <>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
                  <div>
                    <strong>From:</strong> {preview.from_display_name} &lt;{preview.from_address}&gt;
                  </div>
                  <div>
                    <strong>Reply-To:</strong> {preview.reply_to}
                  </div>
                  <div>
                    <strong>To:</strong> {preview.to_name} &lt;{preview.to_email}&gt;
                  </div>
                  <div>
                    <strong>Subject:</strong> {preview.subject}
                  </div>
                </div>
                <iframe
                  title="email-preview"
                  srcDoc={preview.html_body}
                  style={{ width: '100%', height: 480, border: '1px solid #e8e2d4', borderRadius: 4 }}
                />
              </>
            ) : (
              <div style={{ color: '#999', fontSize: 13 }}>Loading preview…</div>
            )}
          </div>
        )}

        {tab === 'survey' && (
          <div style={{ marginTop: 12 }}>
            <iframe
              title="survey-preview"
              src={`/survey/${invite.token}?preview=1`}
              style={{ width: '100%', height: 480, border: '1px solid #e8e2d4', borderRadius: 4 }}
            />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 20 }}>
          <button type="button" onClick={onEdit} style={cancelStyle}>
            Edit questions
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => !busy && onClose()} style={cancelStyle}>
              Close
            </button>
            {approvedBanner ? (
              <button
                type="button"
                onClick={revoke}
                disabled={busy}
                style={{ ...cancelStyle, color: '#a3151a', borderColor: '#a3151a' }}
              >
                {busy ? '…' : 'Revoke approval'}
              </button>
            ) : (
              <button
                type="button"
                onClick={approve}
                disabled={busy}
                style={{ ...primaryStyle, opacity: busy ? 0.6 : 1 }}
              >
                {busy ? 'Approving…' : 'Approve'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const tabActive: React.CSSProperties = {
  background: '#a3151a',
  color: '#fff',
  border: 'none',
  padding: '5px 12px',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};

const tabInactive: React.CSSProperties = {
  background: '#fff',
  color: '#555',
  border: '1px solid #d0c8b4',
  padding: '5px 12px',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
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
  cursor: 'pointer',
};
