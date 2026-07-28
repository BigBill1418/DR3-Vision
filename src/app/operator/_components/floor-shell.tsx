'use client';

// ADR-0065 — the operator surface wrapper. Owns the three things that were
// previously duplicated (inconsistently) across all 9 operator pages:
//
//   1. full-height background + text color, per ADR-0014: BLACK on the pre-PIN
//      auth trio (site picker / name picker / keypad), GREEN on every working
//      surface. Pages used to each declare this, so `bg-*` drifted per page.
//   2. the chrome band (back / Log Out / language).
//   3. top clearance. This is the actual fix for the alignment defect: the
//      locale switcher was `fixed` at the top-right, and pages compensated with
//      whatever top padding someone happened to pick — `pt-20` on some, `py-10`
//      on the site picker (logo overlapped it), `py-8` on the queue (the
//      sign-out button sat UNDER it), `py-6` on the load workflow. With the
//      switcher in a sticky band, content flows below it and no page needs top
//      padding at all.
//
// Pages now render only their own content: `<main className="px-6 pb-8">`.

import { usePathname } from 'next/navigation';
import { FloorChrome } from './floor-chrome';
import { resolveFloorNav } from './floor-nav';

export function FloorShell({ children }: { children: React.ReactNode }) {
  const nav = resolveFloorNav(usePathname() ?? '/operator');
  return (
    <div
      className={`min-h-screen ${
        nav.isAuthSurface ? 'bg-black text-white' : 'bg-dr3-green-deep text-dr3-cream'
      }`}
    >
      <FloorChrome nav={nav} />
      {children}
    </div>
  );
}
