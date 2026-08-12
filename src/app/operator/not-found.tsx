'use client';

// Audit D-3 (2026-08-11) — the operator route-group NOT-FOUND boundary.
//
// ── What was wrong ───────────────────────────────────────────────────────────
// There was no `not-found.tsx` ANYWHERE in the app — only `global-error.tsx` and
// the ADR-0065 Amendment 1 `operator/error.tsx`. So every `notFound()` on a
// floor route fell to Next's auto-generated `/_not-found/page`, which renders
// inside the ROOT layout. It therefore gets no `operator/layout.tsx`: no
// `FloorShell`, no `FloorChrome` (Back / Log Out), no `I18nProvider`, no green
// palette.
//
// That is precisely the screen ADR-0065 Am.1 described and fixed FOR THROWN
// ERRORS ONLY: "a black, English-only … screen with ZERO navigation on a SHARED
// iPad." The recovery is knowing to force-quit the PWA. `error.tsx` closed that
// door; `notFound()` walked in through the window beside it.
//
// FIVE floor routes call `notFound()`:
//   load/[id]/page.tsx:52,117 · queue/page.tsx:86 · [site]/page.tsx:31
//   [site]/[userId]/page.tsx:30,48
// The last of those is reachable by an operator DEACTIVATED mid-shift, which is
// the worst version: a person who did nothing wrong, on a shared kiosk, with no
// control on the screen.
//
// ── Why this ships without the iPad hand-check the audit asked for ───────────
// The audit could not drive the defect end-to-end — the auth redirect intercepts
// every unauthenticated probe (`307 → /operator/<site>` confirmed), so line 117
// is unreachable without an operator session — and recommended ten minutes of
// hand verification first. That verification has NOT been done here, and this
// file is deliberately written so it does not need it: the default 404 has no
// chrome, no locale and no navigation in EVERY scenario, so a page that has all
// three is a strict improvement whether or not the exact repro is confirmed. It
// removes a way to be stranded; it cannot add one.
//
// ── Why it is a Client Component ─────────────────────────────────────────────
// `not-found.tsx` may be either. This one is a client component for one reason:
// `resolveFloorNav(usePathname())` is what turns "somewhere under /operator"
// into a real destination. A server component cannot read the pathname, so it
// could only offer a hardcoded link — and `/operator` itself is the one screen
// in the app with no chrome exit (D-18), which would make it the wrong guess.

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/provider';
import { resolveFloorNav } from './_components/floor-nav';

export default function OperatorNotFound() {
  const t = useT();
  const nav = resolveFloorNav(usePathname() ?? '/operator');

  // The hub when we know the site, the site picker when we do not. Never
  // `router.back()` — the floor iPad's history can point at a replayed or dead
  // entry, which is the reasoning `floor-nav.ts` already carries for every other
  // back destination on this surface.
  const href = nav.siteCode ? `/operator/${nav.siteCode}/today` : '/operator';
  const label = nav.siteCode ? t('floor.error.go_hub') : t('floor.not_found.go_sites');

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t('floor.not_found.heading')}</h1>
          {/* Deliberately NOT "404" and not "page not found". The load page's own
              comment says a 404 "is indistinguishable from 'your load is gone',
              which is alarming rather than informative" — so the copy names the
              only two things that are actually true (it is not here; nothing you
              entered was lost) and then points at the way out. */}
          <p className="text-sm opacity-70">{t('floor.not_found.body')}</p>
        </header>

        <Link
          href={href}
          data-testid="floor-not-found-exit"
          // ADR-0060 gloved-hand sizing — this is the only control on the screen.
          className="min-h-[56px] rounded-lg bg-dr3-green px-6 py-4 text-center text-lg font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream"
        >
          {label}
        </Link>
      </div>
    </main>
  );
}
