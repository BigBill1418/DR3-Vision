'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT, useLocale } from '@/i18n/provider';
import { pacificDateLabel, dayKeyUTCFromISO, formatPacificDateTime } from '@/lib/time';
import type { FloorInboundDayView } from '@/lib/loads/floor-inbound';
import { enqueueAction, isOfflineError, newIdempotencyKey } from '@/lib/offline-queue';
import { NumberStepper } from '../number-stepper';

// ADR-0060 F-2 client — confirm / correct / enter the day's inbound haul counts. Total
// is always derived as program + non-program, so the split invariant can never be broken
// from this surface. On save it POSTs to /api/operator/[site]/inbound and refreshes the
// server data (which re-derives the confirmed/provisional/office state).

type Props = {
  siteCode: string;
  initialRows: FloorInboundDayView[];
};

function chipClass(): string {
  return 'inline-block rounded-full px-3 py-1 text-xs font-semibold';
}

export function InboundClient({ siteCode, initialRows }: Props) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [busyDay, setBusyDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** ADR-0078 — days whose entry is queued locally, NOT server-acked. */
  const [queuedDays, setQueuedDays] = useState<string[]>([]);

  const dateLabel = (iso: string): string => pacificDateLabel(dayKeyUTCFromISO(iso), locale);

  async function post(dateISO: string, program: number, nonProgram: number): Promise<void> {
    setBusyDay(dateISO);
    setError(null);
    // ADR-0078 — one key per submit attempt, reused by the queued entry so a
    // request that landed but lost its response replays to the same write.
    const idempotencyKey = newIdempotencyKey();
    const payload = {
      inboundDate: dateISO,
      totalUnits: program + nonProgram,
      programUnits: program,
      nonProgramUnits: nonProgram,
    };
    try {
      const res = await fetch(`/api/operator/${siteCode}/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errorMessage(body.error));
        return;
      }
      setEditing(null);
      setQueuedDays((prev) => prev.filter((d) => d !== dateISO));
      router.refresh();
    } catch (e) {
      // ADR-0078 D5 — was a bare `catch { setError(…) }`, which discarded the
      // operator's entry on a mid-submit disconnect and told them to retry from
      // memory. The entry is queued now; the day is carried with it so a replay
      // cannot silently re-file it against a different one.
      if (isOfflineError(e)) {
        await enqueueAction({
          scope: 'operator.inbound.confirm',
          site_code: siteCode,
          target_day: dateISO,
          idempotency_key: idempotencyKey,
          payload,
          endpoint: `/api/operator/${siteCode}/inbound`,
        });
        setQueuedDays((prev) => (prev.includes(dateISO) ? prev : [...prev, dateISO]));
        setEditing(null);
      } else {
        setError(t('floor.common.save_failed'));
      }
    } finally {
      setBusyDay(null);
    }
  }

  function errorMessage(reason?: string): string {
    if (reason === 'per_load_exists') return t('floor.inbound.err_per_load');
    if (reason === 'office_owned') return t('floor.inbound.err_office');
    if (reason && /program|non-program|total/i.test(reason)) return t('floor.inbound.err_split');
    return t('floor.common.save_failed');
  }

  if (initialRows.length === 0) {
    return <p className="text-dr3-cream/70">{t('floor.inbound.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-dr3-cream/70">{t('floor.inbound.intro')}</p>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
        >
          {error}
        </p>
      )}
      {queuedDays.length > 0 && (
        <p
          className="rounded-lg bg-amber-900/50 px-4 py-3 text-sm font-medium text-dr3-cream ring-1 ring-amber-400/40"
          data-testid="inbound-queued"
        >
          {t('floor.common.queued')} —{' '}
          {queuedDays.map((d) => t('floor.conflicts.target_day', { day: d })).join(', ')}
        </p>
      )}
      {initialRows.map((row) => (
        <DayCard
          key={row.dateISO}
          row={row}
          label={dateLabel(row.dateISO)}
          isToday={row.isToday}
          editing={editing === row.dateISO}
          busy={busyDay === row.dateISO}
          onEdit={() => {
            setError(null);
            setEditing(row.dateISO);
          }}
          onCancel={() => setEditing(null)}
          onConfirm={(p, np) => post(row.dateISO, p, np)}
          confirmedWhen={
            row.confirmedAt
              ? formatPacificDateTime(new Date(row.confirmedAt), locale, {
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : ''
          }
          chip={chipClass}
        />
      ))}
    </div>
  );
}

function DayCard({
  row,
  label,
  isToday,
  editing,
  busy,
  onEdit,
  onCancel,
  onConfirm,
  confirmedWhen,
  chip,
}: {
  row: FloorInboundDayView;
  label: string;
  isToday: boolean;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onConfirm: (program: number, nonProgram: number) => void;
  confirmedWhen: string;
  chip: () => string;
}) {
  const t = useT();
  const [program, setProgram] = useState(row.programUnits ?? 0);
  const [nonProgram, setNonProgram] = useState(row.nonProgramUnits ?? 0);

  const readOnly = row.officeOwned || row.hasPerLoadCapture;
  const total = program + nonProgram;

  return (
    <section className="rounded-xl bg-dr3-green-dark/40 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">
            {label}
            {isToday && (
              <span className="ms-2 rounded bg-dr3-green px-2 py-0.5 text-xs font-semibold text-dr3-ink">
                {t('floor.common.today')}
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-dr3-cream/70">
            {row.totalUnits == null
              ? '—'
              : `${t('floor.common.total')} ${row.totalUnits} · ${t('floor.common.program')} ${row.programUnits} · ${t('floor.common.non_program')} ${row.nonProgramUnits}`}
          </p>
        </div>
        <StatusChip row={row} confirmedWhen={confirmedWhen} chip={chip} />
      </div>

      {readOnly ? (
        <p className="mt-3 text-sm text-dr3-cream/60">
          {row.officeOwned ? t('floor.inbound.office_locked') : t('floor.inbound.per_load_locked')}
        </p>
      ) : editing ? (
        <div className="mt-4 flex flex-col gap-4">
          <NumberStepper
            label={t('floor.inbound.program_label')}
            value={program}
            onChange={setProgram}
          />
          <NumberStepper
            label={t('floor.inbound.non_program_label')}
            value={nonProgram}
            onChange={setNonProgram}
          />
          <p className="text-lg font-semibold">
            {t('floor.inbound.total_label')}: <span className="tabular-nums">{total}</span>
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy || total < 1}
              onClick={() => onConfirm(program, nonProgram)}
              className="min-h-[56px] flex-1 rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink transition-colors hover:bg-dr3-green disabled:opacity-50"
            >
              {busy ? t('floor.common.saving') : t('floor.inbound.confirm')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="min-h-[56px] rounded-lg bg-dr3-green-deep px-6 py-3 text-lg font-semibold text-dr3-cream/80"
            >
              {t('floor.inbound.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex gap-3">
          {row.provisional && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(row.programUnits ?? 0, row.nonProgramUnits ?? 0)}
              className="min-h-[56px] flex-1 rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink transition-colors hover:bg-dr3-green disabled:opacity-50"
            >
              {busy ? t('floor.common.saving') : t('floor.inbound.confirm')}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            className="min-h-[56px] flex-1 rounded-lg bg-dr3-green-deep px-4 py-3 text-lg font-semibold text-dr3-cream ring-1 ring-dr3-green"
          >
            {row.totalUnits == null ? t('floor.inbound.enter') : t('floor.inbound.correct')}
          </button>
        </div>
      )}
    </section>
  );
}

function StatusChip({
  row,
  confirmedWhen,
  chip,
}: {
  row: FloorInboundDayView;
  confirmedWhen: string;
  chip: () => string;
}) {
  const t = useT();
  if (row.hasPerLoadCapture) {
    return (
      <span className={`${chip()} bg-dr3-steel text-dr3-mist`}>
        {t('floor.inbound.per_load_chip')}
      </span>
    );
  }
  if (row.officeOwned) {
    return (
      <span className={`${chip()} bg-dr3-steel text-dr3-mist`}>
        {t('floor.inbound.office_chip')}
      </span>
    );
  }
  if (row.confirmedByYou) {
    return (
      <span className={`${chip()} bg-dr3-green text-dr3-ink`}>
        {t('floor.inbound.confirmed_by_you_chip', { when: confirmedWhen })}
      </span>
    );
  }
  if (row.floorConfirmed) {
    return (
      <span className={`${chip()} bg-dr3-green text-dr3-ink`}>
        {t('floor.inbound.confirmed_chip')}
      </span>
    );
  }
  if (row.provisional) {
    return (
      <span className={`${chip()} bg-dr3-chartreuse text-dr3-ink`}>
        {t('floor.inbound.provisional_chip')}
      </span>
    );
  }
  return null;
}
