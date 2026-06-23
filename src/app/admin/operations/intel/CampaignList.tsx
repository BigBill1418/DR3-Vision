'use client';

// ADR-0034 — Campaign list + "new campaign" creator for the operational
// intelligence survey admin (super-admin only; gated at the page layer).
//
// No HTML <form> tags (CLAUDE.md hard rule) — the modal collects fields with
// controlled inputs and POSTs on a button onClick. Slug is auto-derived from
// the title and client-validated against ^[a-z0-9-]+$ before submit.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listCampaigns } from '@/lib/survey/campaigns';

type CampaignRow = Awaited<ReturnType<typeof listCampaigns>>[number];

const SLUG_RE = /^[a-z0-9-]+$/;

const DEFAULTS = {
  subject_template: 'DR3 Operations — your input requested for our new data system',
  from_address: 'dr3-vision@svdp.us',
  from_display_name: 'Bill Barnard via DR3-Vision',
  reply_to: 'bill.barnard@svdp.us',
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-');
}

function statusBadge(status: string): { label: string; bg: string; fg: string } {
  switch (status) {
    case 'open':
      return { label: 'open', bg: '#e3f4e8', fg: '#1c7c3b' };
    case 'closed':
      return { label: 'closed', bg: '#ece9e2', fg: '#6b6b6b' };
    default:
      return { label: 'draft', bg: '#eeeeee', fg: '#555555' };
  }
}

function fmt(dt: Date | string | null): string {
  if (!dt) return '—';
  const d = typeof dt === 'string' ? new Date(dt) : dt;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function CampaignList({ campaigns }: { campaigns: CampaignRow[] }) {
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [introText, setIntroText] = useState('');
  const [subject, setSubject] = useState(DEFAULTS.subject_template);
  const [fromAddress, setFromAddress] = useState(DEFAULTS.from_address);
  const [fromDisplay, setFromDisplay] = useState(DEFAULTS.from_display_name);
  const [replyTo, setReplyTo] = useState(DEFAULTS.reply_to);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(title);
  const slugValid = useMemo(() => SLUG_RE.test(effectiveSlug), [effectiveSlug]);
  const canSubmit = title.trim() !== '' && introText.trim() !== '' && slugValid && !submitting;

  async function create() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/operations/intel/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          slug: effectiveSlug,
          intro_text: introText,
          subject_template: subject,
          from_address: fromAddress,
          from_display_name: fromDisplay,
          reply_to: replyTo,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `create failed: ${r.status}`);
      }
      const body = (await r.json()) as { campaign: { id: string } };
      router.push(`/admin/operations/intel/${body.campaign.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
      setSubmitting(false);
    }
  }

  return (
    <main style={{ background: '#f7f3ea', minHeight: '100vh', padding: '32px 16px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div
          style={{
            fontSize: 12,
            color: '#888',
            marginBottom: 8,
          }}
        >
          Admin / Operations / Intelligence Survey
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
          }}
        >
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: '#1a1a1a' }}>
            Operational Intelligence
          </h1>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            style={{
              background: '#a3151a',
              color: '#fff',
              padding: '10px 18px',
              border: 'none',
              borderRadius: 4,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            New campaign
          </button>
        </div>

        <div
          style={{
            background: '#fff',
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: '#f7f3ea', textAlign: 'left', color: '#555' }}>
                <th style={{ padding: '10px 14px' }}>Title</th>
                <th style={{ padding: '10px 14px' }}>Status</th>
                <th style={{ padding: '10px 14px' }}>Invites</th>
                <th style={{ padding: '10px 14px' }}>Opened</th>
                <th style={{ padding: '10px 14px' }}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '24px 14px', color: '#999', textAlign: 'center' }}>
                    No campaigns yet.
                  </td>
                </tr>
              )}
              {campaigns.map((c) => {
                const badge = statusBadge(c.status);
                return (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/admin/operations/intel/${c.id}`)}
                    style={{ borderTop: '1px solid #efeae0', cursor: 'pointer' }}
                  >
                    <td style={{ padding: '12px 14px', fontWeight: 600, color: '#1a1a1a' }}>
                      {c.title}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <span
                        style={{
                          background: badge.bg,
                          color: badge.fg,
                          padding: '2px 10px',
                          borderRadius: 12,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td style={{ padding: '12px 14px', color: '#555' }}>{c._count.invites}</td>
                    <td style={{ padding: '12px 14px', color: '#555' }}>{fmt(c.opened_at)}</td>
                    <td style={{ padding: '12px 14px', color: '#555' }}>{fmt(c.closed_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
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
          }}
          onClick={() => !submitting && setShowModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 6,
              border: '1px solid #e8e2d4',
              width: '100%',
              maxWidth: 560,
              padding: 24,
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#1a1a1a' }}>New campaign</h2>

            <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 12 }}>
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={inputStyle}
            />

            <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 12 }}>
              Slug (URL-safe; lowercase, digits, hyphens)
            </label>
            <input
              type="text"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              style={{
                ...inputStyle,
                borderColor: slugValid ? '#d0c8b4' : '#a3151a',
              }}
            />
            {!slugValid && (
              <div style={{ color: '#a3151a', fontSize: 12, marginTop: 4 }}>
                Slug must match ^[a-z0-9-]+$
              </div>
            )}

            <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 12 }}>
              Intro text
            </label>
            <textarea
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              rows={5}
              style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            />

            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 13, color: '#555', cursor: 'pointer' }}>
                Sender overrides (defaults to SVdP identity)
              </summary>
              <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 8 }}>
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={inputStyle}
              />
              <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 8 }}>
                From address
              </label>
              <input
                type="text"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                style={inputStyle}
              />
              <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 8 }}>
                From display name
              </label>
              <input
                type="text"
                value={fromDisplay}
                onChange={(e) => setFromDisplay(e.target.value)}
                style={inputStyle}
              />
              <label style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 8 }}>
                Reply-to
              </label>
              <input
                type="text"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
                style={inputStyle}
              />
            </details>

            {error && <div style={{ color: '#a3151a', fontSize: 13, marginTop: 12 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button
                type="button"
                onClick={() => !submitting && setShowModal(false)}
                style={cancelStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={create}
                disabled={!canSubmit}
                style={{
                  ...primaryStyle,
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                  opacity: canSubmit ? 1 : 0.6,
                }}
              >
                {submitting ? 'Creating…' : 'Create campaign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

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
};
