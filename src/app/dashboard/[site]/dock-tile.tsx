import Link from 'next/link';
import type { LoadStatus } from '@prisma/client';
import { ElapsedTime } from './elapsed-time';

// Stage-name display for active operator sessions per SPRINT-1-PLAN
// T-010. The set is ONLY the operator-active states — terminal /
// post-operator statuses (`submitted`, `verified`, `rejected`,
// `submitted_to_mymrc`, `processed`) never appear here because the
// page query excludes them. Listed exhaustively to keep TS happy and
// to make a missing case obvious if a future enum value lands.
const STAGE_LABELS: Record<LoadStatus, string> = {
  expected: 'Expected',
  arrived: 'Arrived',
  weight_captured: 'Weight captured',
  unload_started: 'Door open',
  in_progress: 'Counting',
  finished: 'Finishing',
  submitted: 'Submitted',
  verified: 'Verified',
  rejected: 'Rejected',
  submitted_to_mymrc: 'In MyMRC',
  processed: 'Processed',
};

export function stageLabel(status: LoadStatus): string {
  return STAGE_LABELS[status];
}

type Props = {
  siteCode: string;
  load: {
    id: string;
    bol_number: string | null;
    status: LoadStatus;
    arrived_at: Date | null;
    operatorName: string;
    sourceName: string;
  };
};

export function DockTile({ siteCode, load }: Props) {
  // Tiles only render for operator-active loads, so `arrived_at` is
  // populated in practice. Guard for the type system + the seed-data
  // edge case where a load somehow lands here without an arrival time.
  const sinceIso = load.arrived_at ? load.arrived_at.toISOString() : null;
  return (
    <Link
      href={`/dashboard/${siteCode}/load/${load.id}`}
      className="block rounded-lg bg-dr3-green-dark/40 p-4 transition-colors hover:bg-dr3-green-dark/70"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-semibold">{load.operatorName}</span>
        <span className="rounded-full bg-dr3-green/30 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-dr3-cream">
          {stageLabel(load.status)}
        </span>
      </div>
      <p className="mt-1 text-sm text-dr3-cream/80">{load.sourceName}</p>
      <p className="mt-2 text-xs uppercase tracking-wide text-dr3-cream/60">
        BOL{' '}
        <span className="font-mono normal-case text-dr3-cream">{load.bol_number ?? '—'}</span>
      </p>
      <p className="mt-3 text-sm">
        <span className="text-dr3-cream/60">Elapsed </span>
        {sinceIso ? <ElapsedTime since={sinceIso} /> : <span className="font-mono">—</span>}
      </p>
    </Link>
  );
}
