'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { NumberStepper } from '../number-stepper';

// ADR-0060 F-3 client — physical on-hand count. Shows the computed on-hand the system
// EXPECTS, then captures the floor's physical count. When the operator enters a
// program/non-program split, non-program is derived as (total − program) so the split
// always sums (no 422). POSTs to /api/operator/[site]/count and shows the reconciled
// delta in plain language.

type Props = {
  siteCode: string;
  expectedTotal: number;
  jurisdiction: 'california' | 'oregon';
};

type Result = { computedTotal: string; physicalTotal: number; reconciledDelta: number };

export function CountClient({ siteCode, expectedTotal, jurisdiction }: Props) {
  const t = useT();
  const router = useRouter();
  const [primary, setPrimary] = useState(0); // units_indoor (CA) or units_total (OR)
  const [inProcessing, setInProcessing] = useState(0);
  const [splitOn, setSplitOn] = useState(false);
  const [program, setProgram] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const physicalTotal = primary + inProcessing;
  const nonProgram = Math.max(0, physicalTotal - program);
  const primaryLabel =
    jurisdiction === 'california' ? t('floor.count.indoor_label') : t('floor.count.total_label');

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: {
        unitsInProcessing: number;
        poolAttribution: 'measured';
        unitsIndoor?: number;
        unitsTotal?: number;
        programUnits?: number;
        nonProgramUnits?: number;
      } = { unitsInProcessing: inProcessing, poolAttribution: 'measured' };
      if (jurisdiction === 'california') body.unitsIndoor = primary;
      else body.unitsTotal = primary;
      if (splitOn) {
        body.programUnits = Math.min(program, physicalTotal);
        body.nonProgramUnits = nonProgram;
      }
      const res = await fetch(`/api/operator/${siteCode}/count`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error === 'pool_mismatch' ? t('floor.count.err_split') : t('floor.common.save_failed'));
        return;
      }
      setResult((await res.json()) as Result);
      router.refresh();
    } catch {
      setError(t('floor.common.save_failed'));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const d = result.reconciledDelta;
    const msg =
      d === 0
        ? t('floor.count.result_match')
        : d > 0
          ? t('floor.count.result_more', { n: d })
          : t('floor.count.result_fewer', { n: Math.abs(d) });
    return (
      <div className="flex flex-col gap-6">
        <div className="rounded-xl bg-dr3-green-dark/50 p-6 text-center">
          <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
            {t('floor.count.result_heading')}
          </p>
          <p className="mt-1 text-5xl font-bold tabular-nums">{result.physicalTotal}</p>
          <p className="mt-3 text-lg">{msg}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setPrimary(0);
            setInProcessing(0);
            setProgram(0);
            setSplitOn(false);
          }}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
        >
          {t('floor.count.count_again')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-dr3-cream/70">{t('floor.count.intro')}</p>

      <section className="rounded-xl bg-dr3-green-dark/40 p-5">
        <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
          {t('floor.count.expected_heading')}
        </p>
        <p className="mt-1 text-4xl font-bold tabular-nums">{expectedTotal}</p>
      </section>

      {error && (
        <p role="alert" className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white">
          {error}
        </p>
      )}

      <NumberStepper label={primaryLabel} value={primary} onChange={setPrimary} />
      <NumberStepper
        label={t('floor.count.processing_label')}
        value={inProcessing}
        onChange={setInProcessing}
      />

      <p className="text-xl font-bold">
        {t('floor.count.your_total_label')}: <span className="tabular-nums">{physicalTotal}</span>
      </p>

      <label className="flex items-center gap-3 text-base font-semibold">
        <input
          type="checkbox"
          checked={splitOn}
          onChange={(e) => setSplitOn(e.target.checked)}
          className="h-6 w-6 accent-dr3-green"
        />
        {t('floor.count.program_label')} / {t('floor.count.non_program_label')}
      </label>

      {splitOn && (
        <div className="flex flex-col gap-4 rounded-lg bg-dr3-green-dark/30 p-4">
          <NumberStepper
            label={t('floor.count.program_label')}
            value={program}
            onChange={setProgram}
            max={physicalTotal}
          />
          <p className="text-base">
            {t('floor.count.non_program_label')}:{' '}
            <span className="font-bold tabular-nums">{nonProgram}</span>
          </p>
        </div>
      )}

      <button
        type="button"
        disabled={busy || physicalTotal < 0}
        onClick={submit}
        className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
      >
        {busy ? t('floor.common.saving') : t('floor.count.submit')}
      </button>
    </div>
  );
}
