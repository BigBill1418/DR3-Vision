'use client';

// ADR-0030 — Per-site daily production report config card.
//
// CLAUDE.md hard rule #10 — no <form>; all handlers are onClick/onChange.
// Card styling mirrors src/app/bonus/amendments/AmendmentQueue.tsx.
//
// The config prop type is DERIVED from the service so we never drift from the
// real Prisma include shape.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listConfigs } from '@/lib/bonus/daily-report-config';

type Config = Awaited<ReturnType<typeof listConfigs>>[number];

interface Props {
  config: Config;
}

/** Render a Prisma @db.Time value (a 1970 Date) as its UTC HH:MM. */
function timeToHhmm(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().slice(11, 16);
}

export function SiteConfigCard({ config }: Props) {
  const router = useRouter();
  const siteId = config.site.id;

  const [enabled, setEnabled] = useState(config.enabled);
  const [sendTimePt, setSendTimePt] = useState(timeToHhmm(config.send_time_pt));
  const [subjectTemplate, setSubjectTemplate] = useState(config.subject_template);
  const [skipIfZero, setSkipIfZero] = useState(config.skip_if_zero);
  const [skipWeekends, setSkipWeekends] = useState(config.skip_weekends);
  const [skipHolidays, setSkipHolidays] = useState(config.skip_holidays);
  const [includeBonusDollars, setIncludeBonusDollars] = useState(config.include_bonus_dollars);
  const [includeComparisons, setIncludeComparisons] = useState(config.include_comparisons);

  const [newRecipient, setNewRecipient] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const isBusy = busy !== null;

  const save = async () => {
    setBusy('save');
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/production-report/config/${siteId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled,
          sendTimePt,
          subjectTemplate,
          skipIfZero,
          skipWeekends,
          skipHolidays,
          includeBonusDollars,
          includeComparisons,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({ kind: 'err', text: body.error ?? `Save failed (${res.status})` });
        return;
      }
      setMessage({ kind: 'ok', text: 'Saved.' });
      router.refresh();
    } catch (e) {
      setMessage({ kind: 'err', text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/production-report/config/${siteId}/test-send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({ kind: 'err', text: body.error ?? `Test send failed (${res.status})` });
        return;
      }
      setMessage({ kind: 'ok', text: 'Test send dispatched.' });
    } catch (e) {
      setMessage({ kind: 'err', text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const addRecipient = async () => {
    const email = newRecipient.trim();
    if (email.length === 0) return;
    setBusy('add');
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/production-report/config/${siteId}/recipients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({ kind: 'err', text: body.error ?? `Add failed (${res.status})` });
        return;
      }
      setNewRecipient('');
      router.refresh();
    } catch (e) {
      setMessage({ kind: 'err', text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const removeRecipient = async (recipientId: string) => {
    setBusy(`remove:${recipientId}`);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/production-report/config/${siteId}/recipients?id=${encodeURIComponent(recipientId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({ kind: 'err', text: body.error ?? `Remove failed (${res.status})` });
        return;
      }
      router.refresh();
    } catch (e) {
      setMessage({ kind: 'err', text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="rounded-lg border border-dr3-cyan/20 bg-dr3-space-2/60 p-5"
      data-testid={`config-${config.site.code}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-dr3-mist">{config.site.name}</p>
          <p className="text-xs text-dr3-mist-dim">{config.site.code}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-dr3-mist">
          <input
            type="checkbox"
            checked={enabled}
            disabled={isBusy}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-dr3-cyan"
          />
          Enabled
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-dr3-mist">
          Send time (PT, HH:MM)
          <input
            type="time"
            value={sendTimePt}
            disabled={isBusy}
            onChange={(e) => setSendTimePt(e.target.value)}
            className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-dr3-mist">
          Subject template
          <input
            type="text"
            value={subjectTemplate}
            disabled={isBusy}
            onChange={(e) => setSubjectTemplate(e.target.value)}
            className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          />
        </label>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-dr3-mist-dim">Recipients</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {config.recipients.map((r) => {
            const removing = busy === `remove:${r.id}`;
            return (
              <li
                key={r.id}
                className="flex items-center gap-2 rounded-full border border-dr3-steel-light/30 bg-dr3-space/60 px-3 py-1 text-sm text-dr3-mist"
              >
                <span>{r.email}</span>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void removeRecipient(r.id)}
                  className="text-dr3-mist-dim hover:text-dr3-mist disabled:opacity-50"
                  aria-label={`Remove ${r.email}`}
                  data-testid={`remove-recipient-${r.id}`}
                >
                  {removing ? '…' : '×'}
                </button>
              </li>
            );
          })}
          {config.recipients.length === 0 ? (
            <li className="text-sm text-dr3-mist-dim">No recipients.</li>
          ) : null}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="text"
            inputMode="email"
            value={newRecipient}
            disabled={isBusy}
            onChange={(e) => setNewRecipient(e.target.value)}
            placeholder="name@svdp.us"
            className="min-w-[14rem] flex-1 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          />
          <button
            type="button"
            disabled={isBusy || newRecipient.trim().length === 0}
            onClick={() => void addRecipient()}
            className="rounded-md border border-dr3-cyan/40 px-4 py-2 text-sm font-semibold text-dr3-mist hover:bg-dr3-space-2/80 disabled:opacity-50"
          >
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-dr3-mist">
          <input
            type="checkbox"
            checked={skipIfZero}
            disabled={isBusy}
            onChange={(e) => setSkipIfZero(e.target.checked)}
            className="h-4 w-4 accent-dr3-cyan"
          />
          Skip if zero
        </label>
        <label className="flex items-center gap-2 text-sm text-dr3-mist">
          <input
            type="checkbox"
            checked={skipWeekends}
            disabled={isBusy}
            onChange={(e) => setSkipWeekends(e.target.checked)}
            className="h-4 w-4 accent-dr3-cyan"
          />
          Skip weekends
        </label>
        <label className="flex items-center gap-2 text-sm text-dr3-mist">
          <input
            type="checkbox"
            checked={skipHolidays}
            disabled={isBusy}
            onChange={(e) => setSkipHolidays(e.target.checked)}
            className="h-4 w-4 accent-dr3-cyan"
          />
          Skip holidays
        </label>
        <label className="flex items-center gap-2 text-sm text-dr3-mist">
          <input
            type="checkbox"
            checked={includeBonusDollars}
            disabled={isBusy}
            onChange={(e) => setIncludeBonusDollars(e.target.checked)}
            className="h-4 w-4 accent-dr3-cyan"
          />
          Include bonus dollars
        </label>
        <label className="flex items-center gap-2 text-sm text-dr3-mist">
          <input
            type="checkbox"
            checked={includeComparisons}
            disabled={isBusy}
            onChange={(e) => setIncludeComparisons(e.target.checked)}
            className="h-4 w-4 accent-dr3-cyan"
          />
          Include comparisons
        </label>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void save()}
          className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void sendTest()}
          className="rounded-md border border-dr3-cyan/40 px-4 py-2 text-sm font-semibold text-dr3-mist hover:bg-dr3-space-2/80 disabled:opacity-50"
        >
          {busy === 'test' ? 'Sending…' : 'Send test'}
        </button>
      </div>

      {message ? (
        <p
          className={
            message.kind === 'ok'
              ? 'mt-3 text-sm text-dr3-cyan-bright'
              : 'mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200'
          }
          role={message.kind === 'err' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
