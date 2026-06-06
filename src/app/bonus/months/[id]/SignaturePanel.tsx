'use client';

// ADR-0019 §5 — Signature capture panel (T-110 + T-111 override, client component).
//
// CLAUDE.md hard rule #10 — no `<form>` element; buttons post via onClick. No
// component library (hard rule #7) — plain HTML + Tailwind brand tokens.
// English-only (ADR-0017).
//
// T-110: renders the attestation button for the slot the CURRENT signer fills,
// while that slot is unsigned. The server is the source of truth (it derives the
// slot and rejects a re-sign); this just keeps the UI honest.
//
// T-111 (override, ADR-0019 §5): for each slot the viewer is AUTHORIZED to
// override (computed server-side and passed in `overridableSlots`) AND which is
// still unsigned, render a small "Sign on behalf of {name}" link. Clicking opens
// a modal that REQUIRES a free-text reason before it will POST. Asymmetric
// authority (Bill → both slots; Morena → Janette only; Janette → neither) is
// enforced SERVER-SIDE; this prop only governs what the UI offers.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type SignerSlot = 'facility' | 'ops' | null;

interface Props {
  monthId: string;
  /** Which slot the current viewer fills (null = admin/no natural slot). */
  viewerSlot: SignerSlot;
  facilitySigned: boolean;
  opsSigned: boolean;
  /**
   * Slots the viewer is authorized to OVERRIDE (sign on behalf of), computed
   * server-side via `canOverrideSlot`. Defaults to none. A slot is offered only
   * if it is in this list AND still unsigned AND not the viewer's own natural
   * slot (that is the normal sign button, not an override).
   */
  overridableSlots?: Array<'facility' | 'ops'>;
}

const ATTESTATION = 'I certify the above bonus calculations are accurate and authorize payment.';

const SLOT_LABEL: Record<'facility' | 'ops', string> = {
  facility: 'Sign as Facility Manager (Janette)',
  ops: 'Sign as Operations Manager (Morena)',
};

const SLOT_ASSIGNEE: Record<'facility' | 'ops', string> = {
  facility: 'Janette',
  ops: 'Morena',
};

export function SignaturePanel({
  monthId,
  viewerSlot,
  facilitySigned,
  opsSigned,
  overridableSlots = [],
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The slot the active modal is acting on, and whether it is an override.
  const [activeSlot, setActiveSlot] = useState<'facility' | 'ops' | null>(null);
  const [isOverride, setIsOverride] = useState(false);
  const [reason, setReason] = useState('');

  const slotSigned = (slot: 'facility' | 'ops') =>
    slot === 'facility' ? facilitySigned : opsSigned;

  // Natural sign button: viewer owns an unsigned slot.
  const canSign = viewerSlot !== null && !slotSigned(viewerSlot);

  // Override links: authorized slots that are unsigned and not the viewer's own.
  const overrideTargets = overridableSlots.filter(
    (slot) => slot !== viewerSlot && !slotSigned(slot),
  );

  function openNatural() {
    if (!viewerSlot) return;
    setActiveSlot(viewerSlot);
    setIsOverride(false);
    setReason('');
    setError(null);
    setOpen(true);
  }

  function openOverride(slot: 'facility' | 'ops') {
    setActiveSlot(slot);
    setIsOverride(true);
    setReason('');
    setError(null);
    setOpen(true);
  }

  function close() {
    if (submitting) return;
    setOpen(false);
  }

  async function submit() {
    if (!activeSlot) return;
    if (isOverride && reason.trim().length === 0) {
      setError('A reason is required to sign on behalf of another signer.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/bonus/months/${monthId}/sign`, {
        method: 'POST',
        ...(isOverride
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ onBehalfOf: activeSlot, reason: reason.trim() }),
            }
          : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not record your signature. Please try again.');
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setSubmitting(false);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  if (!canSign && overrideTargets.length === 0) {
    return (
      <p className="text-sm text-dr3-mist-dim">
        {viewerSlot && slotSigned(viewerSlot)
          ? 'You have signed this month.'
          : 'You are not an assigned signer for this month.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {canSign && (
        <button
          type="button"
          onClick={openNatural}
          className="self-start rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition hover:bg-dr3-cyan-bright focus:outline-none focus:ring-2 focus:ring-dr3-cyan/70"
        >
          {SLOT_LABEL[viewerSlot!]}
        </button>
      )}

      {overrideTargets.map((slot) => (
        <button
          key={slot}
          type="button"
          onClick={() => openOverride(slot)}
          className="self-start text-sm text-dr3-mist-dim underline underline-offset-4 transition hover:text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan/70"
        >
          Sign on behalf of {SLOT_ASSIGNEE[slot]}
        </button>
      ))}

      {open && activeSlot && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={isOverride ? 'Sign on behalf of another signer' : 'Confirm signature'}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-md rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-dr3-mist shadow-xl">
            <h2 className="text-lg font-bold">
              {isOverride
                ? `Sign on behalf of ${SLOT_ASSIGNEE[activeSlot]}`
                : 'Confirm your signature'}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-dr3-mist-dim">{ATTESTATION}</p>

            {isOverride && (
              <div className="mt-4">
                <label htmlFor="override-reason" className="block text-sm font-medium">
                  Reason for signing on behalf of {SLOT_ASSIGNEE[activeSlot]}
                  <span className="text-red-400"> *</span>
                </label>
                <textarea
                  id="override-reason"
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Janette is on leave this week"
                  className="mt-1 w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:border-dr3-cyan focus:outline-none focus:ring-1 focus:ring-dr3-cyan"
                />
              </div>
            )}

            {error && (
              <p
                role="alert"
                className="mt-3 rounded border border-red-500/30 bg-red-900/40 px-3 py-2 text-sm text-red-100"
              >
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                className="rounded-md px-4 py-2 text-sm font-medium text-dr3-mist-dim hover:text-dr3-mist disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting || (isOverride && reason.trim().length === 0)}
                className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition hover:bg-dr3-cyan-bright disabled:opacity-50"
              >
                {submitting ? 'Signing…' : 'I certify & sign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
