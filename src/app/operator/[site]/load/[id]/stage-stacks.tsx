'use client';

import type { CountMode } from '@prisma/client';
import { useEffect, useState, useTransition } from 'react';
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
  const [stacks, setStacks] = useState<Stack[]>(existingStacks);
  const [mode, setMode] = useState<CountMode | null>(existingStacks[0]?.count_mode ?? null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const total = stacks.reduce((acc, s) => acc + s.unit_count, 0);
  const nextIndex = (stacks.at(-1)?.stack_index ?? 0) + 1;

  const persistStack = (count: number) => {
    if (!mode) return;
    const idx = nextIndex;
    setError(null);
    startTransition(async () => {
      try {
        await addStackAction(siteCode, loadId, idx, count, mode);
        setStacks((prev) => [
          ...prev,
          {
            id: `tmp-${idx}`,
            stack_index: idx,
            unit_count: count,
            count_mode: mode,
          },
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    });
  };

  const finish = () => {
    if (!mode) return;
    setError(null);
    startTransition(async () => {
      try {
        await finishUnloadAction(siteCode, loadId, mode);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Finish failed');
      }
    });
  };

  if (!mode) {
    return (
      <section className="flex flex-col gap-6">
        <header>
          <h2 className="text-2xl font-bold">5. Count the units</h2>
          <p className="text-sm text-dr3-cream/70">Choose how you want to count this load.</p>
        </header>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(['ledger', 'multiplier', 'total'] as CountMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className="rounded-lg bg-dr3-green-dark/50 px-6 py-6 text-lg font-semibold capitalize text-dr3-cream transition-colors hover:bg-dr3-green-dark/80"
            >
              {m === 'ledger' ? 'Tally (+1)' : m === 'multiplier' ? 'Stacks × N' : 'Total only'}
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
          <h2 className="text-2xl font-bold">5. Counting · {modeLabel(mode)}</h2>
          <p className="text-sm text-dr3-cream/70">
            {stacks.length} stacks · {total} units total
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMode(null)}
          className="text-xs text-dr3-cream/60 underline-offset-2 hover:underline"
        >
          Change mode
        </button>
      </header>

      {mode === 'ledger' && <LedgerControls onAdd={persistStack} disabled={isPending} />}
      {mode === 'multiplier' && <MultiplierControls onAdd={persistStack} disabled={isPending} />}
      {mode === 'total' && <TotalControls onAdd={persistStack} disabled={isPending} />}

      {stacks.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-dr3-cream/80">
          {stacks.map((s) => (
            <li key={s.id} className="flex justify-between">
              <span>Stack #{s.stack_index}</span>
              <span className="tabular-nums">{s.unit_count} units</span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <button
        type="button"
        disabled={isPending || stacks.length === 0}
        onClick={finish}
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? 'Finishing…' : 'Finish unload →'}
      </button>

      <Timer unloadStartedAt={unloadStartedAt} />
    </section>
  );
}

function modeLabel(m: CountMode): string {
  return m === 'ledger' ? 'Tally' : m === 'multiplier' ? 'Stacks × N' : 'Total';
}

function LedgerControls({ onAdd, disabled }: { onAdd: (n: number) => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAdd(1)}
      className="rounded-lg bg-dr3-green px-6 py-12 text-3xl font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-40"
    >
      + 1 mattress
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
  const [units, setUnits] = useState('');
  const n = Number.parseInt(units, 10);
  const valid = Number.isInteger(n) && n >= 1;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        Mattresses in this stack
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={units}
          onChange={(e) => setUnits(e.target.value.replace(/\D/g, ''))}
          placeholder="e.g. 12"
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
        Add stack
      </button>
    </div>
  );
}

function TotalControls({ onAdd, disabled }: { onAdd: (n: number) => void; disabled: boolean }) {
  const [units, setUnits] = useState('');
  const n = Number.parseInt(units, 10);
  const valid = Number.isInteger(n) && n >= 1;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        Total mattresses on this load
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={units}
          onChange={(e) => setUnits(e.target.value.replace(/\D/g, ''))}
          placeholder="e.g. 240"
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
        Set total
      </button>
    </div>
  );
}

function Timer({ unloadStartedAt }: { unloadStartedAt: string | null }) {
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
      Timer ·{' '}
      <span className="font-mono tabular-nums text-dr3-cream">
        {m}:{String(s).padStart(2, '0')}
      </span>
    </p>
  );
}
