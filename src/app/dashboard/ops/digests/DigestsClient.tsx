'use client';

// ADR-0045 D2 — digest review client. Hard rule #10 — onClick handlers, no
// <form>. Edit the markdown, Save (draft only), Finalize (audited), then Copy
// the rendered HTML to the clipboard. NO send action — the human sends it.

import { useCallback, useEffect, useState } from 'react';

type DigestKind = 'weekly' | 'board_pack';
type DigestStatus = 'draft' | 'finalized';

interface DigestListRow {
  id: string;
  kind: DigestKind;
  period_start: string;
  period_end: string;
  status: DigestStatus;
  finalized_at: string | null;
}

interface DigestDetail {
  id: string;
  kind: DigestKind;
  period_start: string;
  period_end: string;
  status: DigestStatus;
  body_md: string;
}

function iso(d: string): string {
  return d.slice(0, 10);
}

export function DigestsClient() {
  const [rows, setRows] = useState<DigestListRow[]>([]);
  const [selected, setSelected] = useState<DigestDetail | null>(null);
  const [html, setHtml] = useState('');
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState('');

  const loadList = useCallback(async () => {
    const res = await fetch('/api/ops/digests');
    if (res.ok) setRows(((await res.json()) as { rows: DigestListRow[] }).rows);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const open = async (id: string) => {
    setMsg('');
    const res = await fetch(`/api/ops/digests/${id}`);
    if (!res.ok) return;
    const data = (await res.json()) as { digest: DigestDetail; html: string };
    setSelected(data.digest);
    setDraft(data.digest.body_md);
    setHtml(data.html);
  };

  const save = async () => {
    if (!selected) return;
    const res = await fetch(`/api/ops/digests/${selected.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', body_md: draft }),
    });
    if (res.ok) {
      setMsg('Saved');
      await open(selected.id);
    } else {
      setMsg('Could not save (finalized digests are read-only)');
    }
  };

  const finalize = async () => {
    if (!selected) return;
    const res = await fetch(`/api/ops/digests/${selected.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'finalize' }),
    });
    if (res.ok) {
      setMsg('Finalized — copy the HTML and send it from your mail.');
      await Promise.all([loadList(), open(selected.id)]);
    } else {
      setMsg('Could not finalize');
    }
  };

  const copyHtml = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setMsg('Copy-ready HTML copied to clipboard');
    } catch {
      setMsg('Clipboard blocked — select the preview source manually');
    }
  };

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
      <aside className="space-y-2">
        {rows.length === 0 && <p className="text-sm opacity-60">No digests generated yet.</p>}
        {rows.map((r) => (
          <button
            key={r.id}
            onClick={() => open(r.id)}
            className={`block w-full rounded border px-3 py-2 text-left text-sm ${selected?.id === r.id ? 'border-dr3-cyan bg-black/30' : 'border-white/15 bg-black/10'}`}
          >
            <div className="font-medium">
              {r.kind === 'weekly' ? 'Weekly Updates' : 'Board pack'}
            </div>
            <div className="text-xs opacity-60">
              {iso(r.period_start)} → {iso(r.period_end)} · {r.status}
            </div>
          </button>
        ))}
      </aside>

      <section>
        {!selected && <p className="text-sm opacity-60">Select a digest to review.</p>}
        {selected && (
          <div>
            <div className="mb-3 flex items-center gap-3">
              <span className="rounded bg-white/15 px-2 py-0.5 text-xs uppercase">
                {selected.status}
              </span>
              {msg && <span className="text-xs opacity-80">{msg}</span>}
            </div>
            {selected.status === 'draft' ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={16}
                className="w-full rounded bg-black/30 px-3 py-2 font-mono text-xs text-white"
              />
            ) : (
              <pre className="max-h-[420px] overflow-auto rounded bg-black/30 px-3 py-2 font-mono text-xs text-white/90">
                {selected.body_md}
              </pre>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {selected.status === 'draft' && (
                <>
                  <button onClick={save} className="rounded bg-black/30 px-4 py-2 text-sm">
                    Save draft
                  </button>
                  <button
                    onClick={finalize}
                    className="rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black"
                  >
                    Finalize
                  </button>
                </>
              )}
              <button
                onClick={copyHtml}
                className="rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space"
              >
                Copy HTML to clipboard
              </button>
            </div>

            <div className="mt-4">
              <div className="mb-1 text-xs uppercase tracking-wide opacity-70">Preview</div>
              <iframe
                title="digest preview"
                srcDoc={html}
                className="h-[420px] w-full rounded border border-white/15 bg-white"
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
