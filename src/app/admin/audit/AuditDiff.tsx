'use client';

// T-014 — JSON before/after diff renderer for the audit log viewer.
//
// Tiny in-house component, no dependency. Renders before/after side by
// side; for each top-level key in either snapshot, shows a row whose
// background flags it as added / removed / changed / unchanged. Nested
// values are rendered as a compact JSON literal (one line if it fits
// in ~60 chars, otherwise pretty-printed in a code block).
//
// Why not pull in `react-json-view` or similar? The whole audit
// dataset is "user mutations" — flat-ish row snapshots, never the
// graph-y blobs that justify a tree widget. A 2-column key/value grid
// is more readable AND ships ~0 KB to the client.

import { useMemo } from 'react';
import { adminMessages as M } from '@/app/admin/messages';
import { buildDiff, type DiffKind, type Json } from './diff-util';

interface Props {
  before: Json;
  after: Json;
}

export function AuditDiff({ before, after }: Props) {
  const rows = useMemo(() => buildDiff(before, after), [before, after]);

  if (rows.length === 0) {
    // Nothing to show — both sides are non-objects (e.g. an INSERT
    // with `before: null`), and the change is captured by the action
    // label. Render the raw blobs in a compact form so the operator
    // can still inspect.
    return (
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <SnapshotPanel label={M.audit.beforeLabel} value={before} />
        <SnapshotPanel label={M.audit.afterLabel} value={after} />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-dr3-steel-light/25 bg-dr3-space text-xs">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-dr3-steel-light/20 text-left uppercase tracking-wider text-dr3-cyan">
            <th className="px-3 py-2 text-[10px] font-semibold">Field</th>
            <th className="px-3 py-2 text-[10px] font-semibold">{M.audit.beforeLabel}</th>
            <th className="px-3 py-2 text-[10px] font-semibold">{M.audit.afterLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={`border-b border-dr3-steel-light/15 last:border-b-0 ${rowClass(r.kind)}`}
              data-diff-kind={r.kind}
            >
              <td className="px-3 py-2 align-top font-mono text-dr3-mist">{r.key}</td>
              <td className="px-3 py-2 align-top font-mono">
                {r.kind === 'added' ? (
                  <span className="text-dr3-mist-dim">—</span>
                ) : (
                  <ValueCell value={r.before} />
                )}
              </td>
              <td className="px-3 py-2 align-top font-mono">
                {r.kind === 'removed' ? (
                  <span className="text-dr3-mist-dim">—</span>
                ) : (
                  <ValueCell value={r.after} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Internal — rendering
// ──────────────────────────────────────────────────────────────────

const INLINE_BUDGET = 60;

function ValueCell({ value }: { value: Json }) {
  if (value === undefined) return <span className="text-dr3-mist-dim">—</span>;
  if (value === null) return <span className="text-dr3-mist-dim">null</span>;
  if (typeof value === 'string') {
    return <span className="text-dr3-mist">&quot;{value}&quot;</span>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-dr3-mist">{String(value)}</span>;
  }
  // Object / array — try inline, else pretty.
  const inline = compactJson(value);
  if (inline.length <= INLINE_BUDGET) {
    return <span className="text-dr3-mist">{inline}</span>;
  }
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-dr3-mist">
      {prettyJson(value)}
    </pre>
  );
}

function SnapshotPanel({ label, value }: { label: string; value: Json }) {
  return (
    <div className="rounded-md border border-dr3-steel-light/25 bg-dr3-space p-3">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-dr3-cyan">{label}</div>
      {value === null || value === undefined ? (
        <span className="text-dr3-mist-dim">—</span>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-dr3-mist">
          {prettyJson(value)}
        </pre>
      )}
    </div>
  );
}

function compactJson(v: Json): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

function prettyJson(v: Json): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function rowClass(kind: DiffKind): string {
  switch (kind) {
    case 'added':
      return 'bg-emerald-900/20';
    case 'removed':
      return 'bg-red-900/20';
    case 'changed':
      return 'bg-amber-900/20';
    case 'unchanged':
      return '';
  }
}
