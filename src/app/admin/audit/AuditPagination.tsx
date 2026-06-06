'use client';

// T-014 — pagination strip for /admin/audit. The parent server
// component pre-computes the prev/next hrefs so the canonical URL
// shape (filters + page) lives in one place — and so this client
// component never needs to import the URL builder (keeps the bundle
// thin). Per CLAUDE.md hard rule #10 these are buttons that
// `router.push`, not anchor tags with hand-built hrefs — consistent
// with the loads-list pagination at
// `dashboard/[site]/loads/pagination.tsx`.

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

interface Props {
  page: number;
  totalPages: number;
  prevHref: string | null;
  nextHref: string | null;
}

export function AuditPagination({ page, totalPages, prevHref, nextHref }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const goTo = (href: string | null) => {
    if (!href) return;
    startTransition(() => {
      router.push(href);
    });
  };

  const prevDisabled = !prevHref || isPending;
  const nextDisabled = !nextHref || isPending;

  return (
    <nav
      aria-label="Audit pagination"
      className="flex items-center justify-between gap-4 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-3"
      data-testid="admin-audit-pagination"
    >
      <button
        type="button"
        onClick={() => goTo(prevHref)}
        disabled={prevDisabled}
        className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-1.5 text-sm font-medium text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="admin-audit-page-prev"
      >
        ← Prev
      </button>
      <span className="text-sm text-dr3-mist-dim">
        Page <span className="font-semibold tabular-nums">{page}</span> of{' '}
        <span className="font-semibold tabular-nums">{totalPages}</span>
      </span>
      <button
        type="button"
        onClick={() => goTo(nextHref)}
        disabled={nextDisabled}
        className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-1.5 text-sm font-medium text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="admin-audit-page-next"
      >
        Next →
      </button>
    </nav>
  );
}
