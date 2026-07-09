'use client';

// ADR-0049 — admin workbook-sync client. onClick handlers only (CLAUDE.md hard rule
// #10: no <form> elements). Add/enable a source, watch the run ledger, and drive the
// cutover (parity soft-gate).

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SiteOption {
  id: string;
  label: string;
}
export interface SourceRow {
  id: string;
  siteId: string;
  siteCode: string;
  driveUpn: string;
  folderPath: string;
  shareUrl: string | null;
  namingPattern: string;
  isSyncing: boolean;
  lastPolledISO: string | null;
  lastFileName: string | null;
}
export interface RunRow {
  id: string;
  siteCode: string;
  startedISO: string;
  status: string;
  transportMode: string;
  fileName: string | null;
  changesDetected: boolean;
  cutoverNoop: boolean;
  rowsUpserted: number;
  rowsOverwritten: number;
  rowsSkippedMidedit: number;
  error: string | null;
}
export interface CutoverRow {
  siteId: string;
  siteCode: string;
  surfaceState: 'pilot' | 'live';
  hasSurface: boolean;
  paritySignoff: boolean;
}

const CARD = 'rounded-lg border border-white/10 bg-white/[0.02] p-4';
const INPUT = 'w-full rounded border border-white/15 bg-dr3-space px-2 py-1.5 text-sm text-dr3-mist placeholder:text-dr3-mist-dim/60';
const BTN = 'rounded bg-dr3-cyan/90 px-3 py-1.5 text-sm font-medium text-dr3-space hover:bg-dr3-cyan disabled:opacity-50';
const BTN_GHOST = 'rounded border border-white/20 px-3 py-1.5 text-sm text-dr3-mist hover:bg-white/5 disabled:opacity-50';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true });
}

export function WorkbookSyncClient({
  sources,
  runs,
  cutovers,
  siteOptions,
}: {
  sources: SourceRow[];
  runs: RunRow[];
  cutovers: CutoverRow[];
  siteOptions: SiteOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(`Error: ${json.error ?? res.status}`);
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-8">
      {msg && <p className="rounded bg-white/5 px-3 py-2 text-sm text-dr3-cyan">{msg}</p>}

      <AddSource siteOptions={siteOptions} busy={busy} onAdd={(b) => call('/api/admin/workbook-sync/sources', 'POST', b)} />

      <section className={CARD}>
        <h2 className="text-lg font-semibold">Sources</h2>
        {sources.length === 0 && <p className="mt-2 text-sm text-dr3-mist-dim">No sources configured.</p>}
        <div className="mt-3 space-y-3">
          {sources.map((s) => (
            <div key={s.id} className="rounded border border-white/10 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{s.siteCode}</span>
                <span className={s.isSyncing ? 'text-dr3-cyan' : 'text-dr3-mist-dim'}>
                  {s.isSyncing ? 'syncing' : 'disabled'}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-1 text-dr3-mist-dim sm:grid-cols-2">
                <div>drive: <span className="text-dr3-mist">{s.driveUpn}</span></div>
                <div>folder: <span className="text-dr3-mist">{s.folderPath || '(root)'}</span></div>
                <div>pattern: <span className="text-dr3-mist">{s.namingPattern}</span></div>
                <div>last file: <span className="text-dr3-mist">{s.lastFileName ?? '—'}</span></div>
                <div>last polled (PT): <span className="text-dr3-mist">{fmt(s.lastPolledISO)}</span></div>
              </dl>
              <div className="mt-3">
                <button
                  className={s.isSyncing ? BTN_GHOST : BTN}
                  disabled={busy}
                  onClick={() => call(`/api/admin/workbook-sync/sources/${s.id}`, 'PATCH', { isSyncing: !s.isSyncing })}
                >
                  {s.isSyncing ? 'Disable sync' : 'Enable sync'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-lg font-semibold">Cutover</h2>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Flipping to <strong>live</strong> stops sync (Vision owns its data) and archives every monthly file to R2.
          Soft-gated on Rick&rsquo;s parity signoff.
        </p>
        <div className="mt-3 space-y-4">
          {cutovers.map((c) => (
            <CutoverPanel key={c.siteId} row={c} busy={busy} call={call} />
          ))}
          {cutovers.length === 0 && <p className="text-sm text-dr3-mist-dim">No sources to cut over.</p>}
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-dr3-mist-dim">
              <tr>
                <th className="py-1 pr-3">Started (PT)</th>
                <th className="pr-3">Site</th>
                <th className="pr-3">Status</th>
                <th className="pr-3">Mode</th>
                <th className="pr-3">Chg</th>
                <th className="pr-3">Up</th>
                <th className="pr-3">Ovr</th>
                <th className="pr-3">Mid</th>
                <th className="pr-3">Error</th>
              </tr>
            </thead>
            <tbody className="text-dr3-mist">
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="py-1 pr-3 whitespace-nowrap">{fmt(r.startedISO)}</td>
                  <td className="pr-3">{r.siteCode}</td>
                  <td className={`pr-3 ${r.status === 'ok' ? 'text-dr3-cyan' : 'text-amber-400'}`}>
                    {r.cutoverNoop ? 'cutover' : r.status}
                  </td>
                  <td className="pr-3">{r.transportMode}</td>
                  <td className="pr-3">{r.changesDetected ? 'y' : '—'}</td>
                  <td className="pr-3">{r.rowsUpserted}</td>
                  <td className="pr-3">{r.rowsOverwritten}</td>
                  <td className="pr-3">{r.rowsSkippedMidedit}</td>
                  <td className="pr-3 max-w-[16rem] truncate text-amber-400">{r.error ?? ''}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-2 text-dr3-mist-dim">No runs yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AddSource({
  siteOptions,
  busy,
  onAdd,
}: {
  siteOptions: SiteOption[];
  busy: boolean;
  onAdd: (body: unknown) => Promise<boolean>;
}) {
  const [siteId, setSiteId] = useState(siteOptions[0]?.id ?? '');
  const [driveUpn, setDriveUpn] = useState('kelsey_ruhland@svdp.us');
  const [folderPath, setFolderPath] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [namingPattern, setNamingPattern] = useState('{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm');

  if (siteOptions.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className="text-lg font-semibold">Add a source</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm text-dr3-mist-dim">
          Site
          <select className={INPUT} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {siteOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm text-dr3-mist-dim">
          OneDrive owner UPN
          <input className={INPUT} value={driveUpn} onChange={(e) => setDriveUpn(e.target.value)} />
        </label>
        <label className="text-sm text-dr3-mist-dim">
          Folder path (blank = root)
          <input className={INPUT} value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="Daily Logs" />
        </label>
        <label className="text-sm text-dr3-mist-dim">
          Share URL (optional)
          <input className={INPUT} value={shareUrl} onChange={(e) => setShareUrl(e.target.value)} />
        </label>
        <label className="text-sm text-dr3-mist-dim sm:col-span-2">
          Naming pattern
          <input className={INPUT} value={namingPattern} onChange={(e) => setNamingPattern(e.target.value)} />
        </label>
      </div>
      <button
        className={`${BTN} mt-3`}
        disabled={busy || !siteId}
        onClick={() => onAdd({ siteId, driveUpn, folderPath, shareUrl: shareUrl || undefined, namingPattern })}
      >
        Add source (disabled)
      </button>
    </section>
  );
}

function CutoverPanel({
  row,
  busy,
  call,
}: {
  row: CutoverRow;
  busy: boolean;
  call: (url: string, method: string, body: unknown) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const [signoffNote, setSignoffNote] = useState('');

  const isLive = row.surfaceState === 'live';
  return (
    <div className="rounded border border-white/10 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{row.siteCode}</span>
        <span className={isLive ? 'text-amber-400' : 'text-dr3-cyan'}>{isLive ? 'CUT OVER (live)' : 'syncing (pilot)'}</span>
      </div>
      {!row.hasSurface && (
        <p className="mt-2 text-amber-400">No rollout surface registered for this site — seed it before cutover.</p>
      )}
      {!isLive && (
        <>
          {!row.paritySignoff && (
            <p className="mt-2 text-amber-400">
              ⚠ Rick&rsquo;s parity signoff is NOT recorded. You may override with a note.
            </p>
          )}
          {!row.paritySignoff && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input className={INPUT} style={{ maxWidth: '20rem' }} placeholder="Parity signoff note (Rick)" value={signoffNote} onChange={(e) => setSignoffNote(e.target.value)} />
              <button
                className={BTN_GHOST}
                disabled={busy || signoffNote.trim().length < 3}
                onClick={() => call('/api/admin/workbook-sync/parity-signoff', 'POST', { siteId: row.siteId, note: signoffNote })}
              >
                Record parity signoff
              </button>
            </div>
          )}
          <div className="mt-3 space-y-2">
            <input className={INPUT} placeholder="Cutover criteria note (required)" value={note} onChange={(e) => setNote(e.target.value)} />
            {!row.paritySignoff && (
              <label className="flex items-center gap-2 text-dr3-mist-dim">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                Override missing parity signoff
              </label>
            )}
            <button
              className={BTN}
              disabled={busy || note.trim().length < 3 || !row.hasSurface || (!row.paritySignoff && !override)}
              onClick={() => call('/api/admin/workbook-sync/cutover', 'POST', { siteId: row.siteId, criteriaNote: note, overrideNoParity: override })}
            >
              Cut over {row.siteCode} → live
            </button>
          </div>
        </>
      )}
    </div>
  );
}
