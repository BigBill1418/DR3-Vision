'use client';

// O-2 (2026-07-16) — the admin file-drop inbox client.
//
// Per hard rule #10, NO <form> element: the picker uses a hidden <input> driven
// by onClick/onChange, drag-and-drop uses onDrop, and every mutation is an
// onClick fetch. Deep-space theme (bg-dr3-space / dr3-mist / dr3-cyan) to match
// the repainted admin surfaces. All copy comes from adminMessages.fileDrop (the
// /admin string-table convention).

import { useCallback, useRef, useState } from 'react';
import { adminMessages } from '@/app/admin/messages';
import type { FileDropRow } from '@/lib/file-drop/list';

const M = adminMessages.fileDrop;

// Render an instant in Bill's Pacific wall clock (+ ' PT'), never the browser's
// local zone — matches every other DR3 surface.
function fmt(iso: string): string {
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// ADR-0067 — provenance labels for the `ingest_source` column.
const INGEST_SOURCE_LABEL: Record<FileDropRow['ingestSource'], string> = {
  manual: M.ingestManual,
  email: M.ingestEmail,
  shared_file: M.ingestSharedFile,
};

const STATUS_LABEL: Record<FileDropRow['status'], string> = {
  received: M.statusReceived,
  routed: M.statusRouted,
  discarded: M.statusDiscarded,
};
const STATUS_STYLE: Record<FileDropRow['status'], string> = {
  received: 'bg-dr3-cyan/15 text-dr3-cyan ring-dr3-cyan/30',
  routed: 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30',
  discarded: 'bg-dr3-steel-light/10 text-dr3-mist-dim ring-dr3-steel-light/25',
};

export function FileDropClient({ initialRows }: { initialRows: FileDropRow[] }) {
  const [rows, setRows] = useState<FileDropRow[]>(initialRows);
  const [selected, setSelected] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/file-drops', { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { rows: FileDropRow[] };
      setRows(body.rows);
    }
  }, []);

  const addFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    setSelected((prev) => [...prev, ...Array.from(list)]);
  }, []);

  const upload = useCallback(async () => {
    if (selected.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of selected) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/admin/file-drops', { method: 'POST', body: fd });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          setError(`${M.uploadFailed}: ${file.name} — ${detail.error ?? res.status}`);
          break;
        }
      }
      setSelected([]);
      if (inputRef.current) inputRef.current.value = '';
      await refresh();
    } finally {
      setUploading(false);
    }
  }, [selected, refresh]);

  const patch = useCallback(
    async (id: string, body: { status?: FileDropRow['status']; note?: string | null }) => {
      const res = await fetch(`/api/admin/file-drops/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) await refresh();
      else setError(`${M.uploadFailed}: ${res.status}`);
    },
    [refresh],
  );

  const download = useCallback(async (id: string) => {
    const res = await fetch(`/api/admin/file-drops/${id}/download`, { cache: 'no-store' });
    if (!res.ok) {
      setError(`${M.download}: ${res.status}`);
      return;
    }
    const { url } = (await res.json()) as { url: string };
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="flex flex-col gap-8">
      {/* Dropzone */}
      <section>
        <div
          data-testid="file-drop-zone"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
            dragOver
              ? 'border-dr3-cyan/70 bg-dr3-cyan/5'
              : 'border-dr3-steel-light/30 bg-dr3-space-2/50 hover:border-dr3-cyan/50'
          }`}
        >
          <p className="text-sm text-dr3-mist">{M.dropHint}</p>
          <span className="rounded-lg bg-dr3-cyan/15 px-3 py-1 text-sm font-medium text-dr3-cyan ring-1 ring-dr3-cyan/30">
            {M.pickFiles}
          </span>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="file-drop-input"
          onChange={(e) => addFiles(e.target.files)}
        />

        {selected.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1 text-sm text-dr3-mist-dim">
            {selected.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2">
                <span className="text-dr3-mist">{f.name}</span>
                <span className="text-xs">{humanSize(f.size)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            disabled={selected.length === 0 || uploading}
            onClick={upload}
            data-testid="file-drop-upload"
            className="rounded-lg bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading ? M.uploading : M.upload}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            {M.refresh}
          </button>
          {selected.length === 0 && !uploading && (
            <span className="text-xs text-dr3-mist-dim">{M.selectedNone}</span>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/30">
            {error}
          </p>
        )}
      </section>

      {/* Manifest */}
      <section className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dr3-steel-light/20 bg-dr3-space-2/40 p-6 text-sm text-dr3-mist-dim">
            {M.empty}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((r) => (
              <li
                key={r.id}
                data-testid="file-drop-row"
                className="flex flex-col gap-3 rounded-2xl border border-dr3-steel-light/25 bg-dr3-space-2/70 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-dr3-mist">
                      {r.originalFilename}
                    </p>
                    <p className="mt-0.5 text-xs text-dr3-mist-dim">
                      {r.contentType} · {humanSize(r.byteSize)}
                      {r.detectedKind ? ` · ${r.detectedKind}` : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-dr3-mist-dim">
                      {r.uploadedByName} · {fmt(r.createdISO)}
                    </p>
                    {/* ADR-0067 provenance. Only rendered for a NON-manual row:
                        every pre-ADR-0067 drop is `manual`, and stamping
                        "Uploaded" on all of them would add a column of noise to
                        say what the surface already implies. */}
                    {r.ingestSource !== 'manual' ? (
                      <p
                        className="mt-0.5 text-xs text-dr3-cyan"
                        data-testid="file-drop-ingest-source"
                      >
                        {INGEST_SOURCE_LABEL[r.ingestSource]}
                        {r.docSourceName ? `: ${r.docSourceName}` : ''}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${STATUS_STYLE[r.status]}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {r.downloadable ? (
                    <button
                      type="button"
                      onClick={() => download(r.id)}
                      className="rounded-lg bg-dr3-cyan/15 px-3 py-1 text-sm font-medium text-dr3-cyan ring-1 ring-dr3-cyan/30 hover:bg-dr3-cyan/25"
                    >
                      {M.download}
                    </button>
                  ) : (
                    <span className="text-xs italic text-dr3-mist-dim">{M.notStored}</span>
                  )}
                  {r.status !== 'routed' && (
                    <button
                      type="button"
                      onClick={() => patch(r.id, { status: 'routed' })}
                      className="rounded-lg border border-emerald-400/30 px-3 py-1 text-sm text-emerald-300 hover:bg-emerald-400/10"
                    >
                      {M.markRouted}
                    </button>
                  )}
                  {r.status !== 'discarded' && (
                    <button
                      type="button"
                      onClick={() => patch(r.id, { status: 'discarded' })}
                      className="rounded-lg border border-dr3-steel-light/30 px-3 py-1 text-sm text-dr3-mist-dim hover:bg-dr3-steel-light/10"
                    >
                      {M.markDiscarded}
                    </button>
                  )}
                  {r.status !== 'received' && (
                    <button
                      type="button"
                      onClick={() => patch(r.id, { status: 'received' })}
                      className="rounded-lg border border-dr3-steel-light/30 px-3 py-1 text-sm text-dr3-mist-dim hover:bg-dr3-steel-light/10"
                    >
                      {M.markReceived}
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    defaultValue={r.note ?? ''}
                    placeholder={M.notePlaceholder}
                    onChange={(e) => setNoteDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-dr3-steel-light/25 bg-dr3-space px-3 py-1.5 text-sm text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:border-dr3-cyan/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => patch(r.id, { note: noteDraft[r.id] ?? r.note ?? '' })}
                    className="shrink-0 rounded-lg border border-dr3-steel-light/30 px-3 py-1.5 text-sm text-dr3-mist-dim hover:text-dr3-cyan"
                  >
                    {M.saveNote}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
