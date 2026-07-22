'use client';

// Shared "back to the Vision Dashboard" nav bar (ADR-0064).
//
// The manager surface (bonus / dashboard / admin route groups) had 30 pages
// with NO in-app path back to `/` — you were forced onto the browser Back
// button. Rather than patch every page, this single bar is wired into the
// three route-group layouts so every nested page inherits it.
//
// Design contract (Bill's ask + accessibility):
//   - a real <Link href="/"> to the Vision Dashboard (HOME_ROUTE)
//   - ≥44px touch target (iPad floor use — WCAG 2.5.5 / Apple HIG)
//   - high-contrast, PERSISTENT affordance (bordered pill + chevron icon), so
//     it reads as tappable without relying on hover
//   - a visible focus ring for keyboard users
//   - deep-space dr3 theme (matches VisionShell / SiteSwitchBanner)
//
// Two exports:
//   - BackToDashboardBar — presentational; takes an explicit label/ariaLabel.
//     Used by the English-only /admin layout (ADR-0017 — no I18nProvider there).
//   - BackToDashboardNav — resolves EN/ES/UR strings via `useT()` (CLAUDE.md
//     hard rule #4). Used by the bonus + dashboard layouts, which mount an
//     I18nProvider with the manager dictionary.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import { useT } from '@/i18n/provider';

function ChevronLeftIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function BackToDashboardBar({
  label,
  ariaLabel,
}: {
  label: string;
  ariaLabel: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="sticky top-0 z-40 border-b border-dr3-steel-light/20 bg-dr3-space/90 backdrop-blur supports-[backdrop-filter]:bg-dr3-space/75"
    >
      <div className="mx-auto flex max-w-6xl items-center px-6 py-2 sm:px-10">
        <Link
          href={HOME_ROUTE}
          aria-label={ariaLabel}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-dr3-steel-light/40 px-3 text-sm font-semibold text-dr3-mist transition-colors hover:border-dr3-cyan hover:text-dr3-cyan-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-dr3-space"
        >
          <ChevronLeftIcon />
          <span>{label}</span>
        </Link>
      </div>
    </nav>
  );
}

export function BackToDashboardNav() {
  const t = useT();
  return (
    <BackToDashboardBar
      label={t('nav.back_to_dashboard')}
      ariaLabel={t('nav.back_to_dashboard_aria')}
    />
  );
}
