'use client';

// ADR-0065 — the shared navigation-pill primitive behind BOTH app chromes.
//
// The manager chrome and the operator (iPad) chrome need the SAME affordance —
// icon + label, ≥44px touch target (ADR-0060 / WCAG 2.5.5 / Apple HIG), a
// persistent bordered shape that reads as tappable without hover, and a visible
// focus ring — but they may NOT share a palette. The manager bar is deep-space
// + cyan; reusing that on the iPad would violate CLAUDE.md hard rule #3 and
// ADR-0008/0014, which put the operator field UI on the high-contrast GREEN
// palette because operators work outdoors in daylight.
//
// So the SHAPE lives here and each surface supplies its own PALETTE via
// `toneClass` (SPACE_TONE below for the office; GREEN_TONE in
// `operator/_components/floor-tone.ts` for the floor). One primitive, two
// skins — not two components that drift apart.

import Link from 'next/link';
import type { ReactNode } from 'react';

// GEOMETRY + ACCESSIBILITY ONLY. The palette is NOT here: `toneClass` is
// supplied by the calling surface. That split is enforced by the ADR-0051 /
// C-16 sweep (`office-dark-theme-sweep.test.tsx`), which forbids any green
// brand class under `src/app` outside the floor tree — so the green tone
// literally lives in `operator/_components/floor-tone.ts`, which is where
// ADR-0008 says the green palette belongs. Baking a green tone in here would
// have put floor colors in an office file.
const BASE =
  'inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2';

/** Office/manager tone — deep-space + cyan (ADR-0051). */
export const SPACE_TONE =
  'border-dr3-steel-light/40 text-dr3-mist hover:border-dr3-cyan hover:text-dr3-cyan-bright focus-visible:ring-dr3-cyan focus-visible:ring-offset-dr3-space';

/**
 * Back chevron. Points toward the INLINE START, so it must mirror under
 * `dir="rtl"` (Urdu) — a hardcoded left-pointing chevron points the wrong way
 * for an Urdu operator. `rtl:rotate-180` flips it with the document direction.
 */
export function ChevronBackIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0 rtl:rotate-180"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/**
 * Sign-out glyph (door + outbound arrow). The arrow is directional, so it
 * mirrors under RTL for the same reason the chevron does.
 */
export function LogOutIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0 rtl:rotate-180"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function NavPillLink({
  href,
  label,
  ariaLabel,
  toneClass,
  icon,
}: {
  href: string;
  label: string;
  ariaLabel: string;
  toneClass: string;
  icon?: ReactNode;
}) {
  return (
    <Link href={href} aria-label={ariaLabel} className={`${BASE} ${toneClass}`}>
      {icon}
      <span>{label}</span>
    </Link>
  );
}

export function NavPillButton({
  onClick,
  label,
  ariaLabel,
  toneClass,
  icon,
}: {
  onClick: () => void;
  label: string;
  ariaLabel: string;
  toneClass: string;
  icon?: ReactNode;
}) {
  // Hard rule #10 — onClick handler, never a <form>.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`${BASE} ${toneClass}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
