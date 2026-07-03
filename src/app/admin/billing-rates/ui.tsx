// ADR-0040 D5 — shared presentational bits for the billing-rates client forms.
//
// Pure (no hooks, no server-only imports) so it bundles cleanly into the client
// components that import it. Styling mirrors the DR3 dark tokens used in
// `src/app/admin/users/[id]/UserEditForm.tsx` exactly.

import { type ReactNode } from 'react';

export const inputCls =
  'rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan';

export const primaryBtnCls =
  'inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50';

export const secondaryBtnCls =
  'inline-flex items-center gap-2 rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-1.5 text-sm text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan disabled:cursor-not-allowed disabled:opacity-50';

export const ghostBtnCls =
  'text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline';

export function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-dr3-mist">{label}</span>
      {children}
      {helper ? <span className="text-xs text-dr3-mist-dim">{helper}</span> : null}
    </label>
  );
}

export function ErrorBanner({ message, testid }: { message: string; testid?: string }) {
  return (
    <p
      className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
      role="alert"
      data-testid={testid}
    >
      {message}
    </p>
  );
}

export function SuccessBanner({ message, testid }: { message: string; testid?: string }) {
  return (
    <p className="rounded-md bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100" data-testid={testid}>
      {message}
    </p>
  );
}
