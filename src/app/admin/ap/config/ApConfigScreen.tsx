'use client';

// ADR-0066 §1.4 + §1.6 — the combined AP configuration screen.
//
// Bill's instruction was explicit: co-locate routing and notification prefs on
// ONE screen ("two separate pages for six rows of config is worse"). Both
// `/admin/ap/routing` and `/admin/ap/notifications` render this component; the
// `view` prop only decides which half the page anchors on and which tab reads
// as current.
//
// Two things this UI is deliberately opinionated about:
//
//   1. The second-approver and fallback pickers are keyed on REACHABILITY, and
//      every option shows the account's EMAIL. Bill, Janette and Morena each
//      have a second, email-less operator PIN account in production; a
//      name-keyed picker would let an admin route to one of those and the table
//      would read as fully configured while every notification resolved to
//      nobody. Excluded accounts are disclosed rather than hidden.
//   2. `second_approval_request` is captioned in full, because the obvious
//      reading of it ("email me about all second approvals") is wrong. It is
//      never a broadcast — the toggle can only remove a person from their OWN
//      routed requests.
//
// Every control is an `onClick` handler; no `<form>` element anywhere
// (CLAUDE.md hard rule #10). Mutations `router.refresh()` and never navigate,
// so the URL view state survives a save for free.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { adminMessages as M } from '@/app/admin/messages';
import type {
  ApConfigDto,
  ApConfigProblem,
  ApPersonRef,
  ApRoutingRowDto,
} from '@/lib/ap/admin-config';
import type { ApNotificationEvent } from '@/lib/ap/notification-prefs';
import { buildApConfigHref, type ApConfigParams, type ApConfigView } from './list-url';

const AC = M.apConfig;

const EVENT_LABEL: Record<ApNotificationEvent, string> = {
  new_invoice: AC.eventNewInvoice,
  second_approval_request: AC.eventSecondApproval,
  daily_digest: AC.eventDailyDigest,
  decision_outcome: AC.eventDecisionOutcome,
};

const EVENT_HELP: Record<ApNotificationEvent, string> = {
  new_invoice: AC.eventNewInvoiceHelp,
  second_approval_request: AC.eventSecondApprovalHelp,
  daily_digest: AC.eventDailyDigestHelp,
  decision_outcome: AC.eventDecisionOutcomeHelp,
};

/** The one event with no send path wired (§1.6) — rendered, never writable. */
const INERT_EVENTS: readonly ApNotificationEvent[] = ['decision_outcome'];

interface Props {
  config: ApConfigDto;
  view: ApConfigView;
  params: ApConfigParams;
}

interface RoutingDraft {
  first_approver_id: string;
  second_approver_id: string;
  fallback_approver_id: string | null;
  fallback_after_hours: number;
  active: boolean;
}

const NEW_ROW = '__new__';

export function ApConfigScreen({ config, view, params }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seeded from the routing rows too, not just the approver list: a row can
  // reference someone who is no longer an active approver, and the editor must
  // still be able to name them rather than printing a raw id.
  const personById = useMemo(() => {
    const m = new Map<string, ApPersonRef>();
    for (const p of config.approvers) m.set(p.id, p);
    for (const r of config.routing) {
      m.set(r.first_approver.id, r.first_approver);
      m.set(r.second_approver.id, r.second_approver);
      if (r.fallback_approver) m.set(r.fallback_approver.id, r.fallback_approver);
    }
    return m;
  }, [config.approvers, config.routing]);

  /** Approvers with no active routing row — the only sensible "add" candidates. */
  const unrouted = useMemo(() => {
    const routed = new Set(config.routing.filter((r) => r.active).map((r) => r.first_approver.id));
    // `config.routing` is filtered by the status param, so derive the authoritative
    // set from the problem list, which is always computed over EVERY row.
    const flagged = new Set(
      config.problems
        .filter((p) => p.code === 'missing_routing_row' && p.subjectUserId)
        .map((p) => p.subjectUserId as string),
    );
    return config.approvers.filter((a) => flagged.has(a.id) || !routed.has(a.id));
  }, [config.approvers, config.routing, config.problems]);

  const startEdit = useCallback(
    (row: ApRoutingRowDto) => {
      setError(null);
      setEditing(row.first_approver.id);
      // Normalise onto what the selects can actually offer. A row pointing at an
      // unreachable peer (deactivated, or an email-less operator account) has no
      // matching <option>, so the select would DISPLAY the first peer while the
      // draft still held the broken one — save silently writes something the
      // admin never saw. Reset to a real choice instead, visibly.
      const peers = config.selectable.filter((p) => p.id !== row.first_approver.id);
      const second = peers.some((p) => p.id === row.second_approver.id)
        ? row.second_approver.id
        : (peers[0]?.id ?? '');
      const fallback =
        row.fallback_approver && peers.some((p) => p.id === row.fallback_approver?.id)
          ? row.fallback_approver.id
          : null;
      setDraft({
        first_approver_id: row.first_approver.id,
        second_approver_id: second,
        fallback_approver_id: fallback,
        fallback_after_hours: row.fallback_after_hours,
        active: row.active,
      });
    },
    [config.selectable],
  );

  const startAdd = useCallback(
    (firstApproverId?: string) => {
      setError(null);
      const first = firstApproverId ?? unrouted[0]?.id ?? config.approvers[0]?.id ?? '';
      const second = config.selectable.find((p) => p.id !== first);
      setEditing(NEW_ROW);
      setDraft({
        first_approver_id: first,
        second_approver_id: second?.id ?? '',
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      });
    },
    [unrouted, config.approvers, config.selectable],
  );

  const cancel = useCallback(() => {
    setEditing(null);
    setDraft(null);
    setError(null);
  }, []);

  const saveRouting = useCallback(async () => {
    if (!draft) return;
    if (draft.first_approver_id === draft.second_approver_id) {
      setError(AC.errors.selfPair);
      return;
    }
    setPending('routing');
    setError(null);
    try {
      const res = await fetch('/api/admin/ap/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_routing', ...draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.errors.serverError);
        return;
      }
      setEditing(null);
      setDraft(null);
      router.refresh();
    } catch {
      setError(M.errors.serverError);
    } finally {
      setPending(null);
    }
  }, [draft, router]);

  const togglePref = useCallback(
    async (userId: string, event: ApNotificationEvent, value: boolean) => {
      const cell = `${userId}:${event}`;
      setPending(cell);
      setError(null);
      try {
        const res = await fetch('/api/admin/ap/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set_pref', user_id: userId, event, value }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? M.errors.serverError);
          return;
        }
        router.refresh();
      } catch {
        setError(M.errors.serverError);
      } finally {
        setPending(null);
      }
    },
    [router],
  );

  return (
    <div className="flex flex-col gap-10">
      <Tabs view={view} params={params} />

      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="ap-config-error"
        >
          {error}
        </p>
      ) : null}

      <ProblemsPanel
        problems={config.problems}
        onConfigure={(userId) => startAdd(userId)}
        canConfigure={editing === null}
      />

      <section id="routing" className="flex flex-col gap-4">
        <SectionHeading title={AC.routingHeading} body={AC.routingIntro} />
        <StatusFilter params={params} view={view} />

        <div className="overflow-x-auto rounded-md border border-dr3-steel-light/25 bg-dr3-space-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dr3-steel-light/25 text-left text-xs uppercase tracking-wider text-dr3-cyan">
                <th className="px-4 py-3">{AC.routingColumnFirst}</th>
                <th className="px-4 py-3">{AC.routingColumnSecond}</th>
                <th className="px-4 py-3">{AC.routingColumnFallback}</th>
                <th className="px-4 py-3">{AC.routingColumnHours}</th>
                <th className="px-4 py-3">{AC.routingColumnStatus}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {config.routing.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-center text-dr3-mist-dim"
                    data-testid="ap-routing-empty"
                  >
                    {AC.routingEmpty}
                  </td>
                </tr>
              ) : (
                config.routing.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-dr3-steel-light/15 text-dr3-mist last:border-b-0"
                    data-testid={`ap-routing-row-${r.first_approver.id}`}
                  >
                    <td className="px-4 py-3">
                      <PersonCell person={r.first_approver} />
                    </td>
                    <td className="px-4 py-3">
                      <PersonCell person={r.second_approver} flagUnreachable />
                    </td>
                    <td className="px-4 py-3">
                      {r.fallback_approver ? (
                        <PersonCell person={r.fallback_approver} flagUnreachable />
                      ) : (
                        <span className="text-dr3-mist-dim">{AC.routingFallbackNone}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{r.fallback_after_hours} h</td>
                    <td className="px-4 py-3">
                      {r.active ? (
                        <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200">
                          {AC.routingActive}
                        </span>
                      ) : (
                        <span className="rounded-full bg-stone-900/40 px-2 py-0.5 text-xs text-stone-300">
                          {AC.routingInactive}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => startEdit(r)}
                        className="rounded-md border border-dr3-steel-light/30 px-2 py-1 text-xs text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan"
                        data-testid={`ap-routing-edit-${r.first_approver.id}`}
                      >
                        {AC.routingEdit}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {editing !== null && draft ? (
          <RoutingEditor
            draft={draft}
            isNew={editing === NEW_ROW}
            firstOptions={editing === NEW_ROW ? unrouted : config.approvers}
            selectable={config.selectable}
            pending={pending === 'routing'}
            onChange={setDraft}
            onSave={() => void saveRouting()}
            onCancel={cancel}
            personById={personById}
          />
        ) : (
          <div>
            <button
              type="button"
              onClick={() => startAdd()}
              disabled={config.approvers.length === 0}
              className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="ap-routing-add"
            >
              + {AC.routingAdd}
            </button>
          </div>
        )}

        <Namesakes people={config.namesakes} />
      </section>

      <section id="notifications" className="flex flex-col gap-4">
        <SectionHeading title={AC.prefsHeading} body={AC.prefsIntro} />

        <ul className="flex flex-col gap-2 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4 text-sm text-dr3-mist-dim">
          {config.events.map((ev) => (
            <li key={ev}>
              <span className="font-semibold text-dr3-mist">{EVENT_LABEL[ev]}</span>
              {INERT_EVENTS.includes(ev) ? (
                <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
                  {AC.eventInertBadge}
                </span>
              ) : null}
              <span className="ml-2">{EVENT_HELP[ev]}</span>
            </li>
          ))}
        </ul>

        <div className="overflow-x-auto rounded-md border border-dr3-steel-light/25 bg-dr3-space-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dr3-steel-light/25 text-left text-xs uppercase tracking-wider text-dr3-cyan">
                <th className="px-4 py-3">{AC.prefsColumnPerson}</th>
                {config.events.map((ev) => (
                  <th key={ev} className="px-4 py-3 text-center">
                    {EVENT_LABEL[ev]}
                  </th>
                ))}
                <th className="px-4 py-3">{AC.prefsColumnRow}</th>
              </tr>
            </thead>
            <tbody>
              {config.prefs.length === 0 ? (
                <tr>
                  <td
                    colSpan={config.events.length + 2}
                    className="px-4 py-6 text-center text-dr3-mist-dim"
                    data-testid="ap-prefs-empty"
                  >
                    {AC.prefsEmpty}
                  </td>
                </tr>
              ) : (
                config.prefs.map((p) => (
                  <tr
                    key={p.person.id}
                    className="border-b border-dr3-steel-light/15 text-dr3-mist last:border-b-0"
                    data-testid={`ap-prefs-row-${p.person.id}`}
                  >
                    <td className="px-4 py-3">
                      <PersonCell person={p.person} />
                    </td>
                    {config.events.map((ev) => {
                      const inert = INERT_EVENTS.includes(ev);
                      const cell = `${p.person.id}:${ev}`;
                      return (
                        <td key={ev} className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={p.values[ev]}
                            disabled={inert || pending === cell}
                            title={EVENT_HELP[ev]}
                            aria-label={`${EVENT_LABEL[ev]} — ${p.person.name}`}
                            onChange={(e) => void togglePref(p.person.id, ev, e.target.checked)}
                            className="h-4 w-4 accent-dr3-cyan disabled:cursor-not-allowed disabled:opacity-40"
                            data-testid={`ap-pref-${p.person.id}-${ev}`}
                          />
                        </td>
                      );
                    })}
                    <td className="px-4 py-3">
                      {p.has_row ? (
                        <span className="text-xs text-dr3-mist-dim">{AC.prefsRowStored}</span>
                      ) : (
                        <span
                          className="rounded-full bg-dr3-cyan/15 px-2 py-0.5 text-xs text-dr3-cyan"
                          title={AC.prefsRowDefaultsHelp}
                          data-testid={`ap-prefs-defaults-${p.person.id}`}
                        >
                          {AC.prefsRowDefaults}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-dr3-mist-dim">{AC.prefsRowDefaultsHelp}</p>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Pieces
// ────────────────────────────────────────────────────────────────────

function Tabs({ view, params }: { view: ApConfigView; params: ApConfigParams }) {
  const tabs: { key: ApConfigView; label: string }[] = [
    { key: 'routing', label: AC.tabRouting },
    { key: 'notifications', label: AC.tabNotifications },
  ];
  return (
    <nav className="flex flex-wrap gap-2" aria-label={AC.pageTitle}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={buildApConfigHref(t.key, params)}
          aria-current={view === t.key ? 'page' : undefined}
          data-testid={`ap-config-tab-${t.key}`}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            view === t.key
              ? 'bg-dr3-cyan text-dr3-space'
              : 'border border-dr3-steel-light/30 bg-dr3-space-2 text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function SectionHeading({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-dr3-mist">{title}</h2>
      <p className="mt-1 max-w-4xl text-sm text-dr3-mist-dim">{body}</p>
    </div>
  );
}

function StatusFilter({ params, view }: { params: ApConfigParams; view: ApConfigView }) {
  const options: { value: ApConfigParams['status']; label: string }[] = [
    { value: 'active', label: AC.routingFilterActive },
    { value: 'inactive', label: AC.routingFilterInactive },
    { value: 'all', label: AC.routingFilterAll },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cyan">
        {AC.routingFilterStatus}
      </span>
      {options.map((o) => (
        <Link
          key={o.value}
          href={`${buildApConfigHref(view, { status: o.value })}#routing`}
          data-testid={`ap-routing-filter-${o.value}`}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            params.status === o.value
              ? 'bg-dr3-cyan text-dr3-space'
              : 'border border-dr3-steel-light/30 bg-dr3-space-2 text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan'
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

function ProblemsPanel({
  problems,
  onConfigure,
  canConfigure,
}: {
  problems: ApConfigProblem[];
  onConfigure: (userId: string) => void;
  canConfigure: boolean;
}) {
  if (problems.length === 0) {
    return (
      <section
        className="rounded-md border border-emerald-500/25 bg-emerald-900/15 p-4 text-sm text-emerald-100"
        data-testid="ap-config-problems-none"
      >
        {AC.problemsNone}
      </section>
    );
  }
  return (
    <section
      className="rounded-md border border-amber-500/30 bg-amber-900/15 p-4"
      data-testid="ap-config-problems"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-200">
        {AC.problemsHeading}
      </h2>
      <p className="mt-1 max-w-4xl text-xs text-amber-100/80">{AC.problemsIntro}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {problems.map((p, i) => (
          <li
            key={`${p.code}-${p.subjectUserId ?? i}`}
            className="flex flex-wrap items-center gap-2 text-sm text-amber-50"
            data-testid={`ap-config-problem-${p.code}`}
          >
            <span
              className={`rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
                p.severity === 'error'
                  ? 'bg-red-500/25 text-red-200'
                  : 'bg-amber-500/20 text-amber-200'
              }`}
            >
              {p.severity === 'error' ? AC.severityError : AC.severityWarning}
            </span>
            <span>{p.message}</span>
            {p.code === 'missing_routing_row' && p.subjectUserId && canConfigure ? (
              <button
                type="button"
                onClick={() => onConfigure(p.subjectUserId as string)}
                className="rounded border border-amber-300/40 px-2 py-0.5 text-xs font-medium text-amber-100 hover:bg-amber-500/20"
                data-testid={`ap-config-fix-${p.subjectUserId}`}
              >
                {AC.routingAdd}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PersonCell({
  person,
  flagUnreachable,
}: {
  person: ApPersonRef;
  flagUnreachable?: boolean;
}) {
  return (
    <span className="flex flex-col">
      <span className="font-medium">{person.name}</span>
      <span className="text-xs text-dr3-mist-dim">
        {person.email ?? '— no email —'}
        {person.role ? ` · ${person.role}` : ''}
        {person.is_active ? '' : ' · inactive'}
      </span>
      {flagUnreachable && !person.reachable ? (
        <span className="mt-0.5 w-fit rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-semibold text-red-200">
          unreachable
        </span>
      ) : null}
    </span>
  );
}

function Namesakes({ people }: { people: ApPersonRef[] }) {
  return (
    <details className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/60 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-dr3-mist">
        {AC.namesakesHeading}
      </summary>
      <p className="mt-2 max-w-4xl text-xs text-dr3-mist-dim">{AC.namesakesIntro}</p>
      {people.length === 0 ? (
        <p className="mt-2 text-xs text-dr3-mist-dim" data-testid="ap-namesakes-none">
          {AC.namesakesNone}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {people.map((p) => (
            <li key={p.id} className="text-xs text-dr3-mist" data-testid={`ap-namesake-${p.id}`}>
              {p.name} — {p.email ?? 'no email'} · {p.role ?? 'unknown role'}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function RoutingEditor({
  draft,
  isNew,
  firstOptions,
  selectable,
  pending,
  onChange,
  onSave,
  onCancel,
  personById,
}: {
  draft: RoutingDraft;
  isNew: boolean;
  firstOptions: ApPersonRef[];
  selectable: ApPersonRef[];
  pending: boolean;
  onChange: (d: RoutingDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  personById: Map<string, ApPersonRef>;
}) {
  // Self-pairing is impossible to express: the first approver is never offered
  // as their own second approver or fallback.
  const peers = selectable.filter((p) => p.id !== draft.first_approver_id);
  const first = personById.get(draft.first_approver_id);

  return (
    <div
      className="flex flex-col gap-4 rounded-md border border-dr3-cyan/30 bg-dr3-space-2 p-5"
      data-testid="ap-routing-editor"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={AC.routingColumnFirst} help={isNew ? AC.routingFirstHelp : undefined}>
          {isNew ? (
            <select
              value={draft.first_approver_id}
              onChange={(e) => onChange({ ...draft, first_approver_id: e.target.value })}
              className="w-full rounded border border-dr3-steel-light/30 bg-dr3-space p-2 text-sm text-dr3-mist"
              data-testid="ap-routing-first"
            >
              {firstOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {optionLabel(p)}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded border border-dr3-steel-light/20 bg-dr3-space p-2 text-sm text-dr3-mist">
              {first ? optionLabel(first) : draft.first_approver_id}
            </p>
          )}
        </Field>

        <Field label={AC.routingColumnSecond} help={AC.routingSecondHelp}>
          <select
            value={draft.second_approver_id}
            onChange={(e) => onChange({ ...draft, second_approver_id: e.target.value })}
            className="w-full rounded border border-dr3-steel-light/30 bg-dr3-space p-2 text-sm text-dr3-mist"
            data-testid="ap-routing-second"
          >
            {peers.map((p) => (
              <option key={p.id} value={p.id}>
                {optionLabel(p)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={AC.routingColumnFallback} help={AC.routingFallbackHelp}>
          <select
            value={draft.fallback_approver_id ?? ''}
            onChange={(e) => onChange({ ...draft, fallback_approver_id: e.target.value || null })}
            className="w-full rounded border border-dr3-steel-light/30 bg-dr3-space p-2 text-sm text-dr3-mist"
            data-testid="ap-routing-fallback"
          >
            <option value="">{AC.routingFallbackNone}</option>
            {peers.map((p) => (
              <option key={p.id} value={p.id}>
                {optionLabel(p)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={AC.routingHoursLabel} help={AC.routingHoursHelp}>
          <input
            type="number"
            min={1}
            max={168}
            value={draft.fallback_after_hours}
            onChange={(e) =>
              onChange({ ...draft, fallback_after_hours: Number.parseInt(e.target.value, 10) || 0 })
            }
            className="w-full rounded border border-dr3-steel-light/30 bg-dr3-space p-2 text-sm text-dr3-mist"
            data-testid="ap-routing-hours"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-dr3-mist">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(e) => onChange({ ...draft, active: e.target.checked })}
          className="h-4 w-4 accent-dr3-cyan"
          data-testid="ap-routing-active"
        />
        {AC.routingActiveLabel}
      </label>

      <p className="text-xs text-dr3-mist-dim">{AC.routingSelfPairNote}</p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={pending || !draft.first_approver_id || !draft.second_approver_id}
          className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="ap-routing-save"
        >
          {AC.routingSave}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-dr3-steel-light/30 px-4 py-2 text-sm text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan disabled:opacity-50"
          data-testid="ap-routing-cancel"
        >
          {AC.routingCancel}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cyan">{label}</span>
      {children}
      {help ? <span className="text-xs text-dr3-mist-dim">{help}</span> : null}
    </div>
  );
}

/**
 * Every option carries the EMAIL, not just the name. Two accounts can share a
 * name; only one of them can be notified.
 */
function optionLabel(p: ApPersonRef): string {
  return `${p.name} — ${p.email ?? 'no email'} (${p.role ?? 'unknown'})`;
}
