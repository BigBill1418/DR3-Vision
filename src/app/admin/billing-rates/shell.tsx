// ADR-0040 D5 — shared server-rendered chrome for the billing-rates pages:
// the page shell (dark bg + max-width) and the 403 forbidden panel (shape
// copied from `src/app/admin/users/page.tsx`'s ForbiddenPage).

import Link from 'next/link';
import { type ReactNode } from 'react';
import { HOME_ROUTE } from '@/lib/routes';
import { rateMessages as M } from './messages';

export function RateShell({
  title,
  subtitle,
  backHref,
  backLabel,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  backHref: string;
  backLabel: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link href={backHref} className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
            ← {backLabel}
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
              <p className="max-w-3xl text-sm text-dr3-mist-dim">{subtitle}</p>
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

export function RateForbidden() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold" data-testid="rate-forbidden">
        {M.forbiddenHeading}
      </h1>
      <p className="mt-2 text-dr3-mist-dim">{M.forbiddenBody}</p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
      >
        {M.backToDashboard}
      </Link>
    </main>
  );
}

export function ReadOnlyNotice() {
  return (
    <p
      className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-2 text-sm text-dr3-mist-dim"
      data-testid="rate-readonly-notice"
    >
      {M.readOnlyNotice}
    </p>
  );
}
