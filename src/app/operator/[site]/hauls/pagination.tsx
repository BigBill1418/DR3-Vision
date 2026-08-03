'use client';

// ADR-0074 — Prev / "N of M" / Next for the iPad portal-haul list.
//
// Buttons with `onClick` that `router.push` the new `page` value — not `<a>`
// elements with hand-built hrefs and never a `<form>` (CLAUDE.md hard rule #10).
// Modelled on `src/app/dashboard/[site]/loads/pagination.tsx`, repainted for the
// floor: the manager surface's steel/space palette is illegible outdoors, and the
// controls are sized for a gloved thumb (min 56px) rather than a mouse.
//
// `page=1` is DELETED rather than set, so the canonical first-page URL matches
// what `buildHaulsListHref` produces from the same state.

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';
import { useT } from '@/i18n/provider';

type Props = {
  page: number;
  totalPages: number;
};

export function HaulsPagination({ page, totalPages }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const t = useT();

  const goTo = (next: number) => {
    if (next < 1 || next > totalPages || next === page) return;
    const sp = new URLSearchParams(params.toString());
    if (next === 1) {
      sp.delete('page');
    } else {
      sp.set('page', String(next));
    }
    const qs = sp.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  const label = t('floor.hauls.page_of', { page, total: totalPages });

  return (
    <nav
      aria-label={label}
      className="flex items-center justify-between gap-3 rounded-lg bg-dr3-green-dark/40 p-3"
    >
      <button
        type="button"
        onClick={() => goTo(page - 1)}
        disabled={page <= 1 || isPending}
        className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('floor.hauls.prev')}
      </button>
      <span className="text-sm tabular-nums text-dr3-cream/80">{label}</span>
      <button
        type="button"
        onClick={() => goTo(page + 1)}
        disabled={page >= totalPages || isPending}
        className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('floor.hauls.next')}
      </button>
    </nav>
  );
}
