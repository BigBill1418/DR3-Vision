'use client';

// ADR-0063 — the equipment list's search box.
//
// Search is the primary way an admin reaches a row (D2: 554 assets, and every
// maintenance task starts from a unit number on a work order). It is URL state
// like every other filter, so this component's only job is to push `?q=` and
// let the server component re-query.
//
// No `<form>` element and no submit handler (CLAUDE.md hard rule #10) — the
// button is a plain `onClick`, and Enter is handled with an explicit
// `onKeyDown` rather than by relying on implicit form submission.

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { adminMessages as M } from '@/app/admin/messages';
import { SEARCH_MAX, buildEquipmentListHref, type EquipmentListParams } from './list-url';

interface Props {
  /** The list's current view state; `q` seeds the input. */
  view: EquipmentListParams;
}

export function EquipmentSearchClient({ view }: Props) {
  const router = useRouter();
  const [term, setTerm] = useState(view.q ?? '');

  const go = useCallback(
    (q: string | undefined) => {
      router.push(buildEquipmentListHref({ ...view, q }));
    },
    [router, view],
  );

  const submit = useCallback(() => {
    const t = term.trim();
    go(t ? t : undefined);
  }, [go, term]);

  const clear = useCallback(() => {
    setTerm('');
    go(undefined);
  }, [go]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cyan">
        {M.equipment.searchLabel}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={term}
          maxLength={SEARCH_MAX}
          placeholder={M.equipment.searchPlaceholder}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="min-w-0 flex-1 rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-sm text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-search-input"
        />
        <button
          type="button"
          onClick={submit}
          className="rounded-md bg-dr3-cyan px-3 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright"
          data-testid="admin-equipment-search-submit"
        >
          {M.equipment.searchSubmit}
        </button>
        {view.q ? (
          <button
            type="button"
            onClick={clear}
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-sm text-dr3-mist transition-colors hover:border-dr3-cyan/40 hover:text-dr3-cyan"
            data-testid="admin-equipment-search-clear"
          >
            {M.equipment.searchClear}
          </button>
        ) : null}
      </div>
    </div>
  );
}
