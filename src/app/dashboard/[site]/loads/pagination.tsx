'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';

// Prev / N of M / Next anchored to the URL `page` param. Per
// CLAUDE.md hard rule #10 these are buttons with onClick that
// router.push the new param value, not <a> elements with hand-built
// hrefs and not <form> submissions.

type Props = {
  page: number;
  totalPages: number;
};

export function Pagination({ page, totalPages }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

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

  const prevDisabled = page <= 1 || isPending;
  const nextDisabled = page >= totalPages || isPending;

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-4 rounded-lg bg-dr3-green-dark/30 px-4 py-3"
    >
      <button
        type="button"
        onClick={() => goTo(page - 1)}
        disabled={prevDisabled}
        className="rounded-md bg-dr3-green-dark/60 px-3 py-1.5 text-sm font-medium text-dr3-cream hover:bg-dr3-green-dark/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        ← Prev
      </button>
      <span className="text-sm text-dr3-cream/80">
        Page <span className="font-semibold tabular-nums">{page}</span> of{' '}
        <span className="font-semibold tabular-nums">{totalPages}</span>
      </span>
      <button
        type="button"
        onClick={() => goTo(page + 1)}
        disabled={nextDisabled}
        className="rounded-md bg-dr3-green-dark/60 px-3 py-1.5 text-sm font-medium text-dr3-cream hover:bg-dr3-green-dark/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Next →
      </button>
    </nav>
  );
}
