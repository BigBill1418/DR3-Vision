'use client';

import type { CountMode } from '@prisma/client';
import { useEffect, useState, useTransition } from 'react';
import { useT } from '@/i18n/provider';
import { enqueueAction, isOfflineError, newIdempotencyKey } from '@/lib/offline-queue';
import { addStackAction, finishUnloadAction } from '../../actions';

// Stage 5a — stack counter UI per charter §4.3. Three modes:
//   ledger     — tap +1 per mattress
//   multiplier — "N stacks of M units"
//   total      — type the final number
// Operator picks one mode per load (server records on `count_mode`)
// and stays there for the duration. The visible timer ticks since
// `unload_started_at` in the bottom bar.

type Stack = { id: string; stack_index: number; unit_count: number; count_mode: CountMode };

type Props = {
  siteCode: string;
  loadId: string;
  unloadStartedAt: string | null;
  existingStacks: Stack[];
};

export function StageStacks({ siteCode, loadId, unloadStartedAt, existingStacks }: Props) {
  const t = useT();
  const [stacks, setStacks] = useState<Stack[]>(existingStacks);
  const [mode, setMode] = useState<CountMode | null>(existingStacks[0]?.count_mode ?? null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** ADR-0078 — stacks held locally, awaiting a server ack. Never shown as saved. */
  const [queued, setQueued] = useState(0);

  const total = stacks.reduce((acc, s) => acc + s.unit_count, 0);
  const nextIndex = (stacks.at(-1)?.stack_index ?? 0) + 1;

  // ADR-0078 D2/D6 — a stack is a BILLED unit: `finishUnload` sums `load_stacks`
  // into `total_units`. Losing one silently undercounts the load, and reporting a
  // landed one as failed makes an operator re-enter a count that already exists.
  // The key is minted per tap and carried into the queue, so a retry — live or
  // replayed — resolves to the same row rather than a second one.
  const persistStack = (count: number) => {
    if (!mode) return;
    const idx = nextIndex;
    const idempotencyKey = newIdempotencyKey();
    setError(null);
    // NOT reset here. Clearing the banner on each new tap meant that queueing
    // stack 3 offline and then succeeding on stack 4 hid the warning while
    // stack 3 was still unsent — the list read as fully saved. The count only
    // goes down when something actually leaves the queue.
    const payload = { loadId, stackIndex: idx, unitCount: count, countMode: mode };
    const optimistic = () =>
      setStacks((prev) => [
        ...prev,
        { id: `tmp-${idx}`, stack_index: idx, unit_count: count, count_mode: mode },
      ]);
    startTransition(async () => {
      try {
        await addStackAction(idempotencyKey, siteCode, loadId, idx, count, mode);
        optimistic();
      } catch (e) {
        if (isOfflineError(e)) {
          await enqueueAction({
            scope: 'operator.load.add_stack',
            site_code: siteCode,
            target_day: null,
            idempotency_key: idempotencyKey,
            payload,
            endpoint: 'server-action:addStackAction',
            load_id: loadId,
          });
          // The stack IS shown, and the banner says why it is provisional. The
          // running total has to keep counting or the operator loses their place
          // mid-trailer — but it is never presented as saved.
          optimistic();
          setQueued((n) => n + 1);
        } else {
          setError(e instanceof Error ? e.message : t('stage_stacks.save_failed'));
        }
      }
    });
  };

  const finish = () => {
    if (!mode) return;
    const idempotencyKey = newIdempotencyKey();
    setError(null);
    startTransition(async () => {
      try {
        await finishUnloadAction(idempotencyKey, siteCode, loadId, mode);
      } catch (e) {
        if (isOfflineError(e)) {
          await enqueueAction({
            scope: 'operator.load.finish_unload',
            site_code: siteCode,
            target_day: null,
            idempotency_key: idempotencyKey,
            payload: { loadId, countMode: mode },
            endpoint: 'server-action:finishUnloadAction',
            load_id: loadId,
          });
          setQueued((n) => n + 1);
        } else {
          setError(e instanceof Error ? e.message : t('stage_stacks.finish_failed'));
        }
      }
    });
  };

  if (!mode) {
    return (
      <section className="flex flex-col gap-6">
        <header>
          <h2 className="text-2xl font-bold">{t('stage_stacks.heading_pick_mode')}</h2>
          <p className="text-sm text-dr3-cream/70">{t('stage_stacks.subheading_pick_mode')}</p>
        </header>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(['ledger', 'multiplier', 'total'] as CountMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className="rounded-lg bg-dr3-green-dark/50 px-6 py-6 text-lg font-semibold text-dr3-cream transition-colors hover:bg-dr3-green-dark/80"
            >
              {t(`stage_stacks.mode_${m}`)}
            </button>
          ))}
        </div>
        <Timer unloadStartedAt={unloadStartedAt} />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">
            {t('stage_stacks.heading_counting', { mode: t(`stage_stacks.mode_label_${mode}`) })}
          </h2>
          <p className="text-sm text-dr3-cream/70">
            {t('stage_stacks.stacks_units_summary', { stacks: stacks.length, units: total })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMode(null)}
          className="text-xs text-dr3-cream/60 underline-offset-2 hover:underline"
        >
          {t('stage_stacks.change_mode')}
        </button>
      </header>

      {mode === 'ledger' && <LedgerControls onAdd={persistStack} disabled={isPending} />}
      {mode === 'multiplier' && <MultiplierControls onAdd={persistStack} disabled={isPending} />}
      {mode === 'total' && <TotalControls onAdd={persistStack} disabled={isPending} />}

      {stacks.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-dr3-cream/80">
          {stacks.map((s) => (
            <li key={s.id} className="flex justify-between">
              <span>{t('stage_stacks.stack_index', { n: s.stack_index })}</span>
              <span className="tabular-nums">
                {t('stage_stacks.stack_units', { n: s.unit_count })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      {queued > 0 && (
        <p
          className="rounded-lg bg-amber-900/50 px-4 py-3 text-sm font-medium text-dr3-cream ring-1 ring-amber-400/40"
          data-testid="stacks-queued"
        >
          {t('floor.common.queued')}
        </p>
      )}

      <button
        type="button"
        disabled={isPending || stacks.length === 0}
        onClick={finish}
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? t('stage_stacks.finishing') : t('stage_stacks.finish')}
      </button>

      <Timer unloadStartedAt={unloadStartedAt} />
    </section>
  );
}

function LedgerControls({ onAdd, disabled }: { onAdd: (n: number) => void; disabled: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAdd(1)}
      className="rounded-lg bg-dr3-green px-6 py-12 text-3xl font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-40"
    >
      {t('stage_stacks.ledger_add_one')}
    </button>
  );
}

function MultiplierControls({
  onAdd,
  disabled,
}: {
  onAdd: (n: number) => void;
  disabled: boolean;
}) {
  const t = useT();
  const [units, setUnits] = useState('');
  const n = Number.parseInt(units, 10);
  const valid = Number.isInteger(n) && n >= 1;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('stage_stacks.multiplier_label')}
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={units}
          onChange={(e) => setUnits(e.target.value.replace(/\D/g, ''))}
          placeholder={t('stage_stacks.multiplier_placeholder')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-3 text-2xl tabular-nums text-dr3-cream focus:border-dr3-green focus:outline-none"
        />
      </label>
      <button
        type="button"
        disabled={disabled || !valid}
        onClick={() => {
          onAdd(n);
          setUnits('');
        }}
        className="rounded-lg bg-dr3-green px-6 py-6 text-xl font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('stage_stacks.multiplier_add')}
      </button>
    </div>
  );
}

function TotalControls({ onAdd, disabled }: { onAdd: (n: number) => void; disabled: boolean }) {
  const t = useT();
  const [units, setUnits] = useState('');
  const n = Number.parseInt(units, 10);
  const valid = Number.isInteger(n) && n >= 1;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('stage_stacks.total_label')}
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={units}
          onChange={(e) => setUnits(e.target.value.replace(/\D/g, ''))}
          placeholder={t('stage_stacks.total_placeholder')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-3 text-2xl tabular-nums text-dr3-cream focus:border-dr3-green focus:outline-none"
        />
      </label>
      <button
        type="button"
        disabled={disabled || !valid}
        onClick={() => {
          onAdd(n);
          setUnits('');
        }}
        className="rounded-lg bg-dr3-green px-6 py-6 text-xl font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('stage_stacks.total_set')}
      </button>
    </div>
  );
}

function Timer({ unloadStartedAt }: { unloadStartedAt: string | null }) {
  const t = useT();
  const [elapsedS, setElapsedS] = useState(() => {
    if (!unloadStartedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(unloadStartedAt).getTime()) / 1000));
  });
  useEffect(() => {
    if (!unloadStartedAt) return;
    const id = window.setInterval(() => {
      setElapsedS(
        Math.max(0, Math.floor((Date.now() - new Date(unloadStartedAt).getTime()) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, [unloadStartedAt]);

  const m = Math.floor(elapsedS / 60);
  const s = elapsedS % 60;
  return (
    <p className="rounded-md bg-dr3-green-dark/50 px-3 py-2 text-center text-sm text-dr3-cream/80">
      {t('stage_stacks.timer_label')}{' '}
      <span className="font-mono tabular-nums text-dr3-cream" dir="ltr">
        {m}:{String(s).padStart(2, '0')}
      </span>
    </p>
  );
}
