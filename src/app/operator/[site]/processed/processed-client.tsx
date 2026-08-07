'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { enqueueAction, isOfflineError, newIdempotencyKey } from '@/lib/offline-queue';
import { NumberStepper } from '../number-stepper';

// ADR-0060 F-4 client — confirm today's stripped (processed) counts. Confirm-only:
// program + non-program stripped units. POSTs to /api/operator/[site]/processed
// (upsertProcessedUnits, actor = operator). A closed day is refused server-side (409);
// the surface disables entry when today is already closed.

type Props = {
  siteCode: string;
  productionDate: string;
  initialProgram: number;
  initialNonProgram: number;
  closed: boolean;
};

export function ProcessedClient({
  siteCode,
  productionDate,
  initialProgram,
  initialNonProgram,
  closed,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [program, setProgram] = useState(initialProgram);
  const [nonProgram, setNonProgram] = useState(initialNonProgram);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** ADR-0078 — queued locally, NOT server-acked. Never rendered as Saved. */
  const [queued, setQueued] = useState(false);

  const total = program + nonProgram;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    setQueued(false);
    // ADR-0078 — minted once per attempt and reused by the queued entry.
    const idempotencyKey = newIdempotencyKey();
    const payload = {
      productionDate,
      strippedProgram: program,
      strippedNonProgram: nonProgram,
    };
    try {
      const res = await fetch(`/api/operator/${siteCode}/processed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          b.error === 'closed' ? t('floor.processed.err_closed') : t('floor.common.save_failed'),
        );
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (e) {
      // ADR-0078 D5 — was a bare `catch { setError(…) }`. `setSaved(true)` is
      // deliberately NOT reached from here: the ✓ Saved confirmation means the
      // server acknowledged the write, and nothing weaker may borrow it.
      if (isOfflineError(e)) {
        await enqueueAction({
          scope: 'operator.processed.confirm',
          site_code: siteCode,
          target_day: productionDate,
          idempotency_key: idempotencyKey,
          payload,
          endpoint: `/api/operator/${siteCode}/processed`,
        });
        setQueued(true);
      } else {
        setError(t('floor.common.save_failed'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <p className="rounded-lg bg-dr3-green-dark/40 px-4 py-6 text-center text-lg">
        {t('floor.processed.err_closed')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-dr3-cream/70">{t('floor.processed.intro')}</p>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
        >
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-lg bg-dr3-green/30 px-4 py-3 text-sm font-medium text-dr3-cream">
          {t('floor.common.saved')}
        </p>
      )}
      {queued && (
        <p
          className="rounded-lg bg-amber-900/50 px-4 py-3 text-sm font-medium text-dr3-cream ring-1 ring-amber-400/40"
          data-testid="processed-queued"
        >
          {t('floor.common.queued')}
        </p>
      )}

      <NumberStepper
        label={t('floor.processed.program_label')}
        value={program}
        onChange={(n) => {
          setProgram(n);
          setSaved(false);
        }}
      />
      <NumberStepper
        label={t('floor.processed.non_program_label')}
        value={nonProgram}
        onChange={(n) => {
          setNonProgram(n);
          setSaved(false);
        }}
      />

      <p className="text-xl font-bold">
        {t('floor.processed.total_label')}: <span className="tabular-nums">{total}</span>
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
      >
        {busy ? t('floor.common.saving') : t('floor.processed.submit')}
      </button>
    </div>
  );
}
