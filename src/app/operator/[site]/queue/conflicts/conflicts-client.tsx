'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import {
  listConflicts,
  removeAction,
  removeUpload,
  replayAll,
  resubmitActionToToday,
  retryRow,
  retryAllConflicts,
  type PendingAction,
  type PendingUpload,
} from '@/lib/offline-queue';

// ADR-0078 — the operator's two honest options for a refused entry.
//
// Every conflict row states three things in plain language: WHAT the entry was,
// WHICH day it was for, and WHY the server refused it. A screen that shows a
// count of stuck items without any of those turns a resolvable problem into a
// mystery, which is the state the queue was already in.
//
// `Re-submit to today` appears only where re-filing is semantically meaningful —
// a day-refused, day-addressed entry. It is not offered for a session-expired or
// key-reused conflict, because changing the day would not address either, and an
// action that looks like it should help but cannot is worse than no action.

/**
 * Scopes whose day may be re-filed by an operator, and the field that carries it.
 *
 * ONLY the count. `inbound` and `processed` are deliberately absent, and their
 * absence is the safety property: both write an ABSOLUTE value keyed on the day
 * (`confirmFloorInboundDay` re-confirms in place, `upsertProcessedUnits` upserts
 * on `(site_id, production_date)`). Re-filing Tuesday's 400-unit inbound against
 * today would therefore not add anything — it would OVERWRITE the 260 units the
 * floor already confirmed for today, from one tap, with no diff shown and no
 * confirmation, recoverable only from `audit_log`.
 *
 * A count is an append that establishes a new anchor, so re-filing it is a
 * genuine decision an operator can make. For the other two the honest options
 * are Discard here, or a manager correcting the day on the desktop surface that
 * shows both numbers before it changes one.
 */
const DAY_FIELD: Record<string, string> = {
  'operator.count.create': 'countDate',
};

type Props = { siteCode: string; todayISO: string };

export function ConflictsClient({ siteCode, todayISO }: Props) {
  const t = useT();
  const router = useRouter();
  const [actions, setActions] = useState<PendingAction[]>([]);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const c = await listConflicts();
      setActions(c.actions);
      setUploads(c.uploads);
    } catch {
      // IndexedDB unavailable — render the empty state rather than crashing the
      // one screen an operator was sent to in order to fix something.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Discard: audited server-side FIRST, removed locally only if that lands. */
  async function discard(row: PendingAction | PendingUpload, isUpload: boolean): Promise<void> {
    const reason = window.prompt(t('floor.conflicts.discard_reason')) ?? '';
    if (reason.trim() === '') return;
    setBusy(row.id);
    setError(null);
    try {
      const res = await fetch('/api/queue/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          site_code: siteCode,
          scope: isUpload ? 'operator.photo.confirm' : (row as PendingAction).scope,
          idempotency_key: isUpload
            ? ((row as PendingUpload).idempotency_key ?? null)
            : (row as PendingAction).idempotency_key,
          target_day: isUpload ? null : (row as PendingAction).target_day,
          last_error: row.last_error,
          reason,
        }),
      });
      // The local row is removed ONLY on a server-acknowledged audit write.
      // Deleting first and auditing afterwards would let a failed audit erase
      // the only remaining record that the entry ever existed — the exact
      // shape hard rule #6 exists to prevent.
      if (!res.ok) {
        setError(t('floor.conflicts.discard_failed'));
        return;
      }
      if (isUpload) await removeUpload(row.id);
      else await removeAction(row.id);
      await refresh();
      router.refresh();
    } catch {
      setError(t('floor.conflicts.discard_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function resubmit(row: PendingAction): Promise<void> {
    const field = DAY_FIELD[row.scope];
    if (!field) return;
    setBusy(row.id);
    setError(null);
    try {
      await resubmitActionToToday(row.id, todayISO, field);
      await replayAll();
      await refresh();
      router.refresh();
    } catch {
      setError(t('floor.conflicts.resubmit_failed'));
    } finally {
      setBusy(null);
    }
  }

  /** Retry: clear the flag so the next sweep re-attempts. */
  async function retry(row: PendingAction | PendingUpload, isUpload: boolean): Promise<void> {
    setBusy(row.id);
    setError(null);
    try {
      await retryRow(row.id, isUpload ? 'upload' : 'action');
      await replayAll();
      await refresh();
      router.refresh();
    } catch {
      setError(t('floor.conflicts.retry_failed'));
    } finally {
      setBusy(null);
    }
  }

  /** G5 — release every flag, then ONE sweep. */
  async function retryAll(): Promise<void> {
    setBusy('all');
    setError(null);
    try {
      await retryAllConflicts();
      await replayAll();
      await refresh();
      router.refresh();
    } catch {
      setError(t('floor.conflicts.retry_failed'));
    } finally {
      setBusy(null);
    }
  }

  function reasonLabel(lastError: string | null): string {
    if (lastError === 'conflict:date_not_today') return t('floor.conflicts.why_wrong_day');
    // A parked PHOTO whose re-mint was refused 403/404 is almost always a load
    // that belongs to a different operator's login on this shared iPad. The
    // ownership check is NOT relaxed for replays — the same evidence reaching
    // the server under the wrong identity is still the wrong identity, and this
    // is a shared device where that distinction is the whole point of the PIN.
    // What changes is that the refusal now says what to DO about it.
    if (lastError === 'conflict:manager_hold') return t('floor.conflicts.why_manager_hold');
    if (lastError?.startsWith('conflict:mint 40')) return t('floor.conflicts.why_other_operator');
    if (lastError?.includes('409')) return t('floor.conflicts.why_conflict');
    if (lastError?.includes('401') || lastError?.includes('403'))
      return t('floor.conflicts.why_session');
    return t('floor.conflicts.why_refused');
  }

  function whenLabel(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  function scopeLabel(scope: string): string {
    if (scope === 'operator.count.create') return t('floor.conflicts.what_count');
    if (scope === 'operator.inbound.confirm') return t('floor.conflicts.what_inbound');
    if (scope === 'operator.processed.confirm') return t('floor.conflicts.what_processed');
    return scope;
  }

  if (!loaded) return null;

  if (actions.length === 0 && uploads.length === 0) {
    return (
      <p className="rounded-lg bg-dr3-green-dark/40 px-4 py-8 text-center text-lg">
        {t('floor.conflicts.empty')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-dr3-cream/70">{t('floor.conflicts.intro')}</p>

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void retryAll()}
        data-testid="retry-all"
        className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
      >
        {t('floor.conflicts.retry_all', { count: actions.length + uploads.length })}
      </button>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
        >
          {error}
        </p>
      )}

      {actions.map((row) => {
        const canResubmit = row.last_error === 'conflict:date_not_today' && !!DAY_FIELD[row.scope];
        return (
          <div
            key={row.id}
            className="rounded-xl bg-dr3-green-dark/40 p-5"
            data-testid="conflict-row"
          >
            <p className="text-lg font-bold">{scopeLabel(row.scope)}</p>
            <p className="mt-1 text-sm text-dr3-cream/80">
              {t('floor.conflicts.target_day', { day: row.target_day ?? '—' })}
            </p>
            <p className="mt-1 text-sm text-dr3-cream/70">
              {t('floor.conflicts.queued_at', { when: whenLabel(row.queued_at) })}
            </p>
            <p className="mt-1 text-sm text-amber-200">{reasonLabel(row.last_error)}</p>

            <div className="mt-4 flex flex-wrap gap-3">
              {canResubmit && (
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void resubmit(row)}
                  className="min-h-[48px] rounded-lg bg-dr3-green px-4 py-2 text-base font-bold text-dr3-ink disabled:opacity-50"
                >
                  {t('floor.conflicts.resubmit_today', { day: todayISO })}
                </button>
              )}
              {/* Offered for every conflict, including the day-mismatch: the
                  refusal that parked a row can stop being true (a different
                  operator signs in, infrastructure is fixed), and before this
                  there was no way for anyone to say "try that again now". */}
              {/* Suppressed for a manager hold: the count is already stored and
                  waiting for a person, and each retry mints ANOTHER hold. */}
              {row.last_error !== 'conflict:manager_hold' && (
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void retry(row, false)}
                  className="min-h-[48px] rounded-lg bg-dr3-green-dark/60 px-4 py-2 text-base font-semibold text-dr3-cream disabled:opacity-50"
                >
                  {t('floor.conflicts.retry')}
                </button>
              )}
              <button
                type="button"
                disabled={busy === row.id}
                onClick={() => void discard(row, false)}
                className="min-h-[48px] rounded-lg bg-transparent px-4 py-2 text-base font-semibold text-dr3-cream/80 underline disabled:opacity-50"
              >
                {t('floor.conflicts.discard')}
              </button>
            </div>
          </div>
        );
      })}

      {/* Photo rows. These carry a load reference, a kind and a held-since stamp
          because a parked photo is EVIDENCE — a manager has to be able to work
          out which load it belongs to before anyone decides to discard it. */}
      {uploads.map((row) => (
        <div
          key={row.id}
          className="rounded-xl bg-dr3-green-dark/40 p-5"
          data-testid="conflict-row"
        >
          {/* ADR-0085 — a blob-carrying row is now either a load photo or a whole
              walk-up drop-off, and a parked one has to say WHICH. A drop-off has
              no load to reference; rendering the load line with an empty id would
              tell a manager the photo belongs to load "" — worse than saying
              nothing, because it reads as data rather than as absence. */}
          {row.subject === 'dropoff' && row.dropoff ? (
            <>
              <p className="text-lg font-bold">
                {t(`floor.dropoff.kind_${row.dropoff.kind}`)}
              </p>
              <p className="mt-1 text-sm text-dr3-cream/80">
                {t('floor.conflicts.dropoff_ref', {
                  units: row.dropoff.units,
                  day: row.dropoff.dropoff_date,
                })}
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-bold">
                {t('floor.conflicts.what_photo', { kind: row.kind })}
              </p>
              <p className="mt-1 text-sm text-dr3-cream/80">
                {t('floor.conflicts.load_ref', { id: row.load_id ?? '—' })}
              </p>
            </>
          )}
          <p className="mt-1 text-sm text-dr3-cream/70">
            {t('floor.conflicts.queued_at', { when: whenLabel(row.queued_at) })}
          </p>
          <p className="mt-1 text-sm text-amber-200">{reasonLabel(row.last_error)}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy === row.id}
              onClick={() => void retry(row, true)}
              className="min-h-[48px] rounded-lg bg-dr3-green px-4 py-2 text-base font-bold text-dr3-ink disabled:opacity-50"
            >
              {t('floor.conflicts.retry')}
            </button>
            <button
              type="button"
              disabled={busy === row.id}
              onClick={() => void discard(row, true)}
              className="min-h-[48px] rounded-lg bg-transparent px-4 py-2 text-base font-semibold text-dr3-cream/80 underline disabled:opacity-50"
            >
              {t('floor.conflicts.discard')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
