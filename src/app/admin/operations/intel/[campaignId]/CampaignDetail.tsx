'use client';

// ADR-0034 — Campaign detail: header actions (Send / Close / Export), the
// invite roster with per-status actions, and an Add-invite modal. No HTML
// <form> tags; all mutations fire on button onClick (CLAUDE.md hard rule).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { getCampaignWithInvites } from '@/lib/survey/campaigns';
import { InviteEditor } from './InviteEditor';
import { InvitePreview } from './InvitePreview';
import { SendInterstitial } from './SendInterstitial';

type Campaign = NonNullable<Awaited<ReturnType<typeof getCampaignWithInvites>>>;
type Invite = Campaign['invites'][number];

function inviteBadge(status: string): { label: string; bg: string; fg: string; border?: string } {
  switch (status) {
    case 'approved':
      return { label: 'approved', bg: '#ffcc69', fg: '#5a4500' };
    case 'sent':
      return { label: 'sent', bg: '#e0ecff', fg: '#1d4ed8' };
    case 'opened':
      return { label: 'opened', bg: '#fff', fg: '#1c7c3b', border: '1px solid #1c7c3b' };
    case 'submitted':
      return { label: 'submitted', bg: '#1c7c3b', fg: '#fff' };
    default:
      return { label: 'draft', bg: '#eeeeee', fg: '#555' };
  }
}

function fmt(dt: Date | string | null): string {
  if (!dt) return '—';
  const d = typeof dt === 'string' ? new Date(dt) : dt;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function statusPill(status: string): { background: string; color: string } {
  switch (status) {
    case 'open':
      return { background: '#e3f4e8', color: '#1c7c3b' };
    case 'closed':
      return { background: '#ece9e2', color: '#6b6b6b' };
    default:
      return { background: '#eeeeee', color: '#555555' };
  }
}

export function CampaignDetail({ campaign }: { campaign: Campaign }) {
  const router = useRouter();
  const [editorInvite, setEditorInvite] = useState<Invite | null>(null);
  const [previewInvite, setPreviewInvite] = useState<Invite | null>(null);
  const [showSend, setShowSend] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const approved = campaign.invites.filter((i) => i.status === 'approved');
  const submitted = campaign.invites.filter((i) => i.status === 'submitted');
  const isClosed = campaign.status === 'closed';
  const canSend = !isClosed && approved.length > 0;

  function refresh() {
    router.refresh();
  }

  function flash(kind: 'info' | 'error', text: string) {
    setNotice({ kind, text });
    if (kind === 'info') setTimeout(() => setNotice(null), 6000);
  }

  async function closeCampaign() {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/operations/intel/campaigns/${campaign.id}/close`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`Close failed (${r.status}).`);
      setShowCloseConfirm(false);
      flash('info', 'Campaign closed. The markdown export was generated.');
      refresh();
    } catch (e) {
      flash('error', e instanceof Error ? e.message : 'Close failed.');
    } finally {
      setBusy(false);
    }
  }

  async function exportNow() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch(
        `/api/admin/operations/intel/campaigns/${campaign.id}/close?export_only=true`,
        { method: 'POST' },
      );
      if (!r.ok) throw new Error(`Export failed (${r.status}).`);
      const body = (await r.json()) as { files: Array<{ path: string }> };
      flash('info', `Export ready: ${body.files.length} file(s) generated.`);
    } catch (e) {
      flash('error', e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ background: '#f7f3ea', minHeight: '100vh', padding: '32px 16px' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => router.push('/admin/operations/intel')}
            style={{ background: '#fff', border: '1px solid #e8e2d4', borderRadius: 6, color: '#a3151a', cursor: 'pointer', padding: '8px 14px', fontSize: 14, fontWeight: 600 }}
          >
            ← Back to all campaigns
          </button>
        </div>

        <div
          style={{
            background: '#fff',
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            padding: 20,
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{ margin: 0, fontSize: 24, color: '#1a1a1a' }}>{campaign.title}</h1>
                <span
                  style={{
                    ...statusPill(campaign.status),
                    padding: '2px 10px',
                    borderRadius: 12,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {campaign.status}
                </span>
              </div>
              <div style={{ fontSize: 13, color: '#666', marginTop: 6 }}>
                Created by {campaign.created_by.name} · {campaign.invites.length}{' '}
                {campaign.invites.length === 1 ? 'invite' : 'invites'} · {approved.length} approved ·{' '}
                {submitted.length} submitted
              </div>
              <div style={{ fontSize: 13, color: '#666', marginTop: 2 }}>
                Opened {fmt(campaign.opened_at)} · Closed {fmt(campaign.closed_at)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setShowSend(true)}
                disabled={!canSend || busy}
                title={
                  isClosed
                    ? 'Campaign is closed'
                    : approved.length === 0
                      ? 'Approve at least one invite first'
                      : `Review and send ${approved.length} approved invite(s)`
                }
                style={{
                  ...primaryStyle,
                  cursor: canSend && !busy ? 'pointer' : 'not-allowed',
                  opacity: canSend ? 1 : 0.5,
                }}
              >
                Send Campaign{approved.length > 0 ? ` (${approved.length})` : ''}
              </button>
              <button
                type="button"
                onClick={exportNow}
                disabled={busy}
                style={{ ...cancelStyle, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}
              >
                {busy ? 'Working…' : 'Export now'}
              </button>
              <button
                type="button"
                onClick={() => setShowCloseConfirm(true)}
                disabled={isClosed || busy}
                style={{
                  ...cancelStyle,
                  color: '#a3151a',
                  borderColor: '#a3151a',
                  opacity: isClosed || busy ? 0.5 : 1,
                  cursor: isClosed || busy ? 'not-allowed' : 'pointer',
                }}
              >
                Close Campaign
              </button>
            </div>
          </div>
          {!isClosed && approved.length === 0 && (
            <div style={{ fontSize: 12, color: '#888', marginTop: 12 }}>
              Preview an invite and approve it to enable sending. Nothing is sent until you approve
              and confirm.
            </div>
          )}
          {notice && (
            <div
              role={notice.kind === 'error' ? 'alert' : undefined}
              style={{
                fontSize: 13,
                marginTop: 12,
                padding: '8px 12px',
                borderRadius: 4,
                color: notice.kind === 'error' ? '#a3151a' : '#1c7c3b',
                background: notice.kind === 'error' ? '#fbf2f2' : '#e3f4e8',
                border: `1px solid ${notice.kind === 'error' ? '#e7c9c9' : '#bfe3cb'}`,
              }}
            >
              {notice.text}
            </div>
          )}
        </div>

        <div
          style={{
            background: '#fff',
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: '1px solid #efeae0',
            }}
          >
            <strong style={{ color: '#1a1a1a' }}>Invites ({campaign.invites.length})</strong>
            {!isClosed && (
              <button type="button" onClick={() => setShowAdd(true)} style={cancelStyle}>
                + Add invite
              </button>
            )}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f7f3ea', textAlign: 'left', color: '#555' }}>
                <th style={{ padding: '8px 14px' }}>Name</th>
                <th style={{ padding: '8px 14px' }}>Role</th>
                <th style={{ padding: '8px 14px' }}>Status</th>
                <th style={{ padding: '8px 14px' }}>Sent</th>
                <th style={{ padding: '8px 14px' }}>Opened</th>
                <th style={{ padding: '8px 14px' }}>Submitted</th>
                <th style={{ padding: '8px 14px' }}></th>
              </tr>
            </thead>
            <tbody>
              {campaign.invites.map((i) => {
                const badge = inviteBadge(i.status);
                const canPreview = i.status === 'draft' || i.status === 'approved';
                return (
                  <tr key={i.id} style={{ borderTop: '1px solid #efeae0' }}>
                    <td style={{ padding: '10px 14px', color: '#1a1a1a' }}>
                      {i.recipient_name}
                      <div style={{ fontSize: 11, color: '#999' }}>{i.recipient_email}</div>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#555' }}>{i.role_label}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span
                        style={{
                          background: badge.bg,
                          color: badge.fg,
                          border: badge.border,
                          padding: '2px 10px',
                          borderRadius: 12,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#555' }}>{fmt(i.sent_at)}</td>
                    <td style={{ padding: '10px 14px', color: '#555' }}>{fmt(i.first_opened_at)}</td>
                    <td style={{ padding: '10px 14px', color: '#555' }}>{fmt(i.submitted_at)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      {canPreview ? (
                        <button
                          type="button"
                          onClick={() => setPreviewInvite(i)}
                          style={miniBtn}
                        >
                          {i.status === 'approved' ? 'Review' : 'Preview'}
                        </button>
                      ) : (
                        <button type="button" onClick={() => setEditorInvite(i)} style={miniBtn}>
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editorInvite && (
        <InviteEditor
          campaignId={campaign.id}
          invite={editorInvite}
          onClose={() => setEditorInvite(null)}
          onSaved={() => {
            setEditorInvite(null);
            refresh();
          }}
        />
      )}

      {previewInvite && (
        <InvitePreview
          campaignId={campaign.id}
          invite={previewInvite}
          onClose={() => setPreviewInvite(null)}
          onEdit={() => {
            const inv = previewInvite;
            setPreviewInvite(null);
            setEditorInvite(inv);
          }}
          onChanged={refresh}
        />
      )}

      {showSend && (
        <SendInterstitial
          campaignId={campaign.id}
          campaignTitle={campaign.title}
          approvedInvites={approved}
          onClose={() => setShowSend(false)}
          onDone={refresh}
        />
      )}

      {showAdd && (
        <AddInvite
          campaignId={campaign.id}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}

      {showCloseConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => !busy && setShowCloseConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 6,
              border: '1px solid #e8e2d4',
              padding: 24,
              maxWidth: 420,
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>Close campaign?</h2>
            <p style={{ fontSize: 14, color: '#555' }}>
              This locks the campaign and generates the markdown export. No further invites can be
              added or sent.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setShowCloseConfirm(false)} style={cancelStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={closeCampaign}
                disabled={busy}
                style={{ ...primaryStyle, opacity: busy ? 0.6 : 1 }}
              >
                {busy ? 'Closing…' : 'Close campaign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── Add-invite modal (name/email/role + minimal question packet) ─────────

function AddInvite({
  campaignId,
  onClose,
  onAdded,
}: {
  campaignId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [firstPrompt, setFirstPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    name.trim() !== '' && email.trim() !== '' && role.trim() !== '' && firstPrompt.trim() !== '';

  async function add() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // Every packet ends with the standard closing question (ADR-0034).
      const questions = [
        { position: 1, kind: 'long_text', prompt: firstPrompt.trim(), is_required: false },
        {
          position: 2,
          kind: 'long_text',
          prompt: 'What are we missing? What should we be looking at that we haven\'t asked about?',
          is_required: false,
        },
      ];
      const r = await fetch(`/api/admin/operations/intel/campaigns/${campaignId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_name: name.trim(),
          recipient_email: email.trim(),
          role_label: role.trim(),
          questions,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `add failed: ${r.status}`);
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add failed');
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
        padding: '40px 16px',
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
          maxWidth: 480,
          padding: 24,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>Add invite</h2>
        <label style={labelStyle}>Recipient name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>Recipient email</label>
        <input type="text" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>Role label</label>
        <input type="text" value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>First question prompt</label>
        <textarea
          value={firstPrompt}
          onChange={(e) => setFirstPrompt(e.target.value)}
          rows={3}
          style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <p style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
          The standard closing question is appended automatically. Add more questions in the editor
          after creating.
        </p>
        {error && <div style={{ color: '#a3151a', fontSize: 13, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={() => !busy && onClose()} style={cancelStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={add}
            disabled={!canSubmit || busy}
            style={{
              ...primaryStyle,
              cursor: canSubmit && !busy ? 'pointer' : 'not-allowed',
              opacity: canSubmit && !busy ? 1 : 0.6,
            }}
          >
            {busy ? 'Adding…' : 'Add invite'}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  color: '#555',
  marginTop: 12,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
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
  padding: '9px 16px',
  border: 'none',
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
};

const miniBtn: React.CSSProperties = {
  background: '#fff',
  color: '#a3151a',
  padding: '4px 12px',
  border: '1px solid #d0c8b4',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
