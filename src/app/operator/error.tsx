'use client';

// ADR-0065 Amendment 1 (2026-07-30) — the operator route-group error boundary.
//
// ── What was wrong ───────────────────────────────────────────────────────────
// `src/app/global-error.tsx` was the ONLY error boundary in the app. It renders
// its own `<html>`/`<body>`, which means it REPLACES the operator layout — so it
// discards FloorShell, the green palette, the locale provider, and, critically,
// the FloorChrome band that carries Back and Log Out. A floor operator who hit any
// thrown error landed on a black, English-only "Something went wrong" screen with
// ZERO navigation on a SHARED iPad. No back. No Log Out. No language. The only
// recovery is knowing to force-quit the PWA — which is exactly the stranding
// ADR-0064/0065 exist to prevent, arriving through the one path nobody had gated.
//
// ── Why a route-group boundary fixes it ──────────────────────────────────────
// An `error.tsx` at `src/app/operator/` is rendered INSIDE
// `src/app/operator/layout.tsx`. So the FloorShell background, the I18nProvider,
// and the FloorChrome band (Back → the hub, Log Out → the name picker) all survive
// the error. The operator always has a way out, in their own language, on the
// correct palette. `global-error.tsx` stays as the last-resort boundary for a
// failure in the root layout itself, which this cannot catch.
//
// It also gives a RETRY. Most floor failures are transient (the iPad's connection
// dropped mid-action, a `revalidatePath` raced a deploy), and `reset()` re-renders
// the segment without a full reload — which matters because a full reload on the
// floor can serve a stale Serwist shell.
//
// Reporting goes to GlitchTip exactly as `global-error.tsx` does, so moving the
// operator subtree onto its own boundary does not lose telemetry. Sentry no-ops
// with no DSN configured (fail-open).

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/provider';
import { resolveFloorNav } from './_components/floor-nav';

export default function OperatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  const nav = resolveFloorNav(usePathname() ?? '/operator');

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t('floor.error.heading')}</h1>
          <p className="text-sm opacity-70">{t('floor.error.body')}</p>
        </header>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => reset()}
            // ADR-0060 gloved-hand sizing — this is the primary recovery control.
            className="min-h-[56px] rounded-lg bg-dr3-green px-6 py-4 text-lg font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream"
          >
            {t('floor.error.retry')}
          </button>

          {/* A second, independent exit. The chrome band above already carries
              Back + Log Out, but on the hub itself the chrome has no Back pill
              (the hub IS the back destination), so an error there would otherwise
              offer only Retry. `nav.siteCode` is null only on `/operator`, which
              is already the top of the tree. */}
          {nav.siteCode && (
            <Link
              href={`/operator/${nav.siteCode}/today`}
              className="min-h-[56px] rounded-lg bg-dr3-green-deep px-6 py-4 text-center text-lg font-semibold text-dr3-cream ring-1 ring-dr3-green"
            >
              {t('floor.error.go_hub')}
            </Link>
          )}
        </div>

        {/* The digest is the only handle a manager can give Bill to find the event
            in GlitchTip. Rendered small and un-translated on purpose — it is an
            identifier, not prose. */}
        {error.digest && (
          <p className="text-xs opacity-50">
            {t('floor.error.reference')} <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
    </main>
  );
}
