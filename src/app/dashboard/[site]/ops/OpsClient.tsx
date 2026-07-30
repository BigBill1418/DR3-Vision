'use client';

// ADR-0045 D1 — ops ledger client: task queue (with filters) + notes list/editor.
// Hard rule #10 — no <form>; every handler is onClick/onChange. English-first
// (manager/office surface). Reach is enforced server-side; the org-wide toggle is
// only offered when the caller has org reach (`canWriteOrgWide`).

import { useCallback, useEffect, useState } from 'react';
import { appTodayISO } from '@/lib/time';

type TaskStatus = 'open' | 'done' | 'dropped';

interface TaskRow {
  id: string;
  site_id: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  source: string;
  due_date: string | null;
  assignee_user_id: string | null;
}

interface NoteRow {
  id: string;
  site_id: string | null;
  note_date: string;
  title: string | null;
  body: string;
  tasks: { id: string; title: string; status: TaskStatus; due_date: string | null }[];
}

interface ActionItem {
  title: string;
  due_date: string;
}

function iso(d: string | null): string {
  return d ? d.slice(0, 10) : '—';
}
// ADR-0065 Amendment 2 — the Pacific day, not the UTC day.
//
// This read `new Date().toISOString().slice(0, 10)`. `toISOString()` converts to
// UTC first, so from 5:00 PM Pacific (00:00Z the next day) it returned TOMORROW —
// and every date input on this screen defaulted to a day that had not happened.
// An evening entry silently landed on the wrong production day.
//
// `appTodayISO` already existed for exactly this ("for client default values");
// six client screens each rolled their own instead. Use the shared one.
function todayIso(): string {
  return appTodayISO();
}

export interface Assignee {
  id: string;
  name: string;
}

export function OpsClient({
  siteCode,
  canWriteOrgWide,
  assignees = [],
}: {
  siteCode: string;
  canWriteOrgWide: boolean;
  assignees?: Assignee[];
}) {
  const [tab, setTab] = useState<'tasks' | 'notes'>('tasks');
  return (
    <div className="mt-8">
      <div className="mb-4 flex gap-2">
        {(['tasks', 'notes'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-4 py-2 text-sm font-medium ${tab === t ? 'bg-dr3-cyan text-black' : 'bg-black/20 text-white'}`}
          >
            {t === 'tasks' ? 'Task queue' : 'Meeting notes'}
          </button>
        ))}
      </div>
      {tab === 'tasks' ? (
        <TaskQueue siteCode={siteCode} canWriteOrgWide={canWriteOrgWide} assignees={assignees} />
      ) : (
        <NotesPanel siteCode={siteCode} canWriteOrgWide={canWriteOrgWide} />
      )}
    </div>
  );
}

function TaskQueue({
  siteCode,
  canWriteOrgWide,
  assignees,
}: {
  siteCode: string;
  canWriteOrgWide: boolean;
  assignees: Assignee[];
}) {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [status, setStatus] = useState<'' | TaskStatus>('open');
  const [overdue, setOverdue] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [orgWide, setOrgWide] = useState(false);
  const [msg, setMsg] = useState('');

  const assigneeName = useCallback(
    (uid: string | null): string | null =>
      uid ? (assignees.find((a) => a.id === uid)?.name ?? null) : null,
    [assignees],
  );

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (overdue) p.set('overdue', '1');
    const res = await fetch(`/api/ops/${siteCode}/tasks?${p.toString()}`);
    if (res.ok) setRows(((await res.json()) as { rows: TaskRow[] }).rows);
  }, [siteCode, status, overdue]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!title.trim()) {
      setMsg('Title required');
      return;
    }
    const res = await fetch(`/api/ops/${siteCode}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        due_date: due || undefined,
        org_wide: orgWide,
        assignee_user_id: assignee || undefined,
      }),
    });
    if (res.ok) {
      setTitle('');
      setDue('');
      setAssignee('');
      setOrgWide(false);
      setMsg('Task added');
      await load();
    } else {
      setMsg('Could not add task');
    }
  };

  const transition = async (id: string, to: TaskStatus) => {
    const res = await fetch(`/api/ops/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: to }),
    });
    if (res.ok) await load();
  };

  const reassign = async (id: string, uid: string) => {
    const res = await fetch(`/api/ops/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignee_user_id: uid || null }),
    });
    if (res.ok) await load();
    else setMsg('Could not reassign');
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-white/15 bg-black/10 p-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task title"
          className="min-w-[220px] flex-1 rounded bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="rounded bg-black/30 px-3 py-2 text-sm text-white"
        />
        {assignees.length > 0 && (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="rounded bg-black/30 px-3 py-2 text-sm text-white"
            aria-label="Assign to"
          >
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {canWriteOrgWide && (
          <label className="flex items-center gap-1 text-xs opacity-80">
            <input
              type="checkbox"
              checked={orgWide}
              onChange={(e) => setOrgWide(e.target.checked)}
            />
            Org-wide
          </label>
        )}
        <button
          onClick={create}
          className="rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black"
        >
          Add task
        </button>
        {msg && <span className="text-xs opacity-80">{msg}</span>}
      </div>

      <div className="mb-3 flex items-center gap-3 text-sm">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | TaskStatus)}
          className="rounded bg-black/30 px-2 py-1 text-white"
        >
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="dropped">Dropped</option>
        </select>
        <label className="flex items-center gap-1 opacity-80">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          Overdue only
        </label>
      </div>

      <ul className="space-y-2">
        {rows.length === 0 && <li className="text-sm opacity-60">No tasks match.</li>}
        {rows.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between rounded border border-white/10 bg-black/10 px-4 py-3"
          >
            <div>
              <div className="text-sm font-medium">
                {t.title}
                {t.site_id === null && (
                  <span className="ml-2 rounded bg-white/15 px-1.5 text-[10px] uppercase">
                    org-wide
                  </span>
                )}
              </div>
              <div className="text-xs opacity-60">
                due {iso(t.due_date)} · {t.status} · {t.source}
                {assigneeName(t.assignee_user_id) && (
                  <span className="ml-1 text-dr3-cyan">· @{assigneeName(t.assignee_user_id)}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {assignees.length > 0 && t.status === 'open' && (
                <select
                  value={t.assignee_user_id ?? ''}
                  onChange={(e) => reassign(t.id, e.target.value)}
                  className="rounded bg-black/30 px-2 py-1 text-xs text-white"
                  aria-label="Reassign to"
                >
                  <option value="">Unassigned</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              {t.status !== 'done' && (
                <button
                  onClick={() => transition(t.id, 'done')}
                  className="rounded bg-dr3-cyan px-3 py-1 text-xs font-semibold text-dr3-space"
                >
                  Done
                </button>
              )}
              {t.status === 'open' && (
                <button
                  onClick={() => transition(t.id, 'dropped')}
                  className="rounded bg-black/30 px-3 py-1 text-xs"
                >
                  Drop
                </button>
              )}
              {t.status !== 'open' && (
                <button
                  onClick={() => transition(t.id, 'open')}
                  className="rounded bg-black/30 px-3 py-1 text-xs"
                >
                  Reopen
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotesPanel({ siteCode, canWriteOrgWide }: { siteCode: string; canWriteOrgWide: boolean }) {
  const [rows, setRows] = useState<NoteRow[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [noteDate, setNoteDate] = useState(todayIso());
  const [orgWide, setOrgWide] = useState(false);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/ops/${siteCode}/notes`);
    if (res.ok) setRows(((await res.json()) as { rows: NoteRow[] }).rows);
  }, [siteCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const addItem = () => setItems((prev) => [...prev, { title: '', due_date: '' }]);
  const setItem = (i: number, patch: Partial<ActionItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const create = async () => {
    if (!body.trim()) {
      setMsg('Body required');
      return;
    }
    const res = await fetch(`/api/ops/${siteCode}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: title || undefined,
        body,
        note_date: noteDate,
        org_wide: orgWide,
        action_items: items.filter((i) => i.title.trim()),
      }),
    });
    if (res.ok) {
      setTitle('');
      setBody('');
      setItems([]);
      setOrgWide(false);
      setMsg('Note saved');
      await load();
    } else {
      setMsg('Could not save note');
    }
  };

  return (
    <div>
      <div className="mb-6 rounded-lg border border-white/15 bg-black/10 p-4">
        <div className="flex flex-wrap gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title (optional)"
            className="min-w-[220px] flex-1 rounded bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40"
          />
          <input
            type="date"
            value={noteDate}
            onChange={(e) => setNoteDate(e.target.value)}
            className="rounded bg-black/30 px-3 py-2 text-sm text-white"
          />
          {canWriteOrgWide && (
            <label className="flex items-center gap-1 text-xs opacity-80">
              <input
                type="checkbox"
                checked={orgWide}
                onChange={(e) => setOrgWide(e.target.checked)}
              />
              Org-wide
            </label>
          )}
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Meeting notes…"
          rows={3}
          className="mt-3 w-full rounded bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40"
        />
        <div className="mt-3">
          <div className="mb-1 text-xs uppercase tracking-wide opacity-70">
            Action items → tasks
          </div>
          {items.map((it, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input
                value={it.title}
                onChange={(e) => setItem(i, { title: e.target.value })}
                placeholder="Action item"
                className="flex-1 rounded bg-black/30 px-3 py-1.5 text-sm text-white placeholder:text-white/40"
              />
              <input
                type="date"
                value={it.due_date}
                onChange={(e) => setItem(i, { due_date: e.target.value })}
                className="rounded bg-black/30 px-2 py-1.5 text-sm text-white"
              />
            </div>
          ))}
          <button onClick={addItem} className="rounded bg-black/30 px-3 py-1 text-xs">
            + Add action item
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={create}
            className="rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black"
          >
            Save note
          </button>
          {msg && <span className="text-xs opacity-80">{msg}</span>}
        </div>
      </div>

      <ul className="space-y-3">
        {rows.length === 0 && <li className="text-sm opacity-60">No notes yet.</li>}
        {rows.map((n) => (
          <li key={n.id} className="rounded border border-white/10 bg-black/10 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">
                {n.title ?? 'Untitled note'}
                {n.site_id === null && (
                  <span className="ml-2 rounded bg-white/15 px-1.5 text-[10px] uppercase">
                    org-wide
                  </span>
                )}
              </div>
              <div className="text-xs opacity-60">{iso(n.note_date)}</div>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm opacity-90">{n.body}</p>
            {n.tasks.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-white/10 pt-2">
                {n.tasks.map((t) => (
                  <li key={t.id} className="text-xs opacity-80">
                    ☐ {t.title} — {t.status}
                    {t.due_date ? ` (due ${iso(t.due_date)})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
