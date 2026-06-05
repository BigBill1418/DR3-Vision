// T-107 (ADR-0020) — branded Vision Dashboard shell.
//
// The product's front door. Wraps the tile grid in a DR3-green-deep page with:
//   - a header band: DR3 Vision wordmark + tagline + signed-in user info
//   - a large faded "DR3" typographic watermark bottom-right (placeholder; no
//     logo asset yet — ADR-0012 §5 logo is reserved for the splash page)
//   - section labels (ACTIVE / COMING SOON) in chartreuse small-caps
//   - a footer: an "All systems operational" pill placeholder + version string
//
// Server component. Children are the rendered tile sections (the page composes
// them so this stays presentation-only).

import * as React from 'react';
import type { ReactNode } from 'react';

interface VisionShellProps {
  userName: string;
  userEmail: string | null;
  role: string;
  activeSection: ReactNode;
  comingSoonSection: ReactNode;
}

export function VisionShell({
  userName,
  userEmail,
  role,
  activeSection,
  comingSoonSection,
}: VisionShellProps) {
  const version = process.env['GIT_SHA'] ?? 'dev';

  return (
    <main className="relative min-h-screen overflow-hidden bg-dr3-green-deep text-dr3-cream">
      {/* faded typographic watermark — placeholder for the logo asset */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-16 -right-8 select-none text-[16rem] font-black leading-none tracking-tighter text-dr3-cream/[0.03] sm:text-[22rem]"
      >
        DR3
      </span>

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 sm:px-10 sm:py-12">
        {/* ── Header band ───────────────────────────────────────── */}
        <header className="flex flex-col gap-6 border-b border-dr3-cream/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
              DR3 <span className="text-dr3-chartreuse">Vision</span>
            </h1>
            <p className="text-sm uppercase tracking-[0.2em] text-dr3-cream/60">
              Operations · compliance · payroll
            </p>
          </div>
          <div className="flex items-center gap-3 text-right">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-dr3-cream">{userName}</span>
              <span className="text-xs text-dr3-cream/50">
                {userEmail ?? '—'} · {role}
              </span>
            </div>
            <span
              className="flex h-10 w-10 items-center justify-center rounded-full bg-dr3-green text-sm font-bold text-dr3-green-deep"
              aria-hidden="true"
            >
              {initials(userName)}
            </span>
          </div>
        </header>

        {/* ── Active section ────────────────────────────────────── */}
        <section className="pt-10">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.25em] text-dr3-chartreuse">
            Active
          </h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {activeSection}
          </div>
        </section>

        {/* ── Coming soon section ───────────────────────────────── */}
        <section className="pt-12">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.25em] text-dr3-chartreuse/70">
            Coming soon
          </h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {comingSoonSection}
          </div>
        </section>

        {/* ── Footer ────────────────────────────────────────────── */}
        <footer className="mt-auto flex flex-col gap-3 border-t border-dr3-cream/10 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-2 rounded-full bg-dr3-green-dark/60 px-3 py-1 text-xs font-medium text-dr3-cream/80">
            <span className="h-2 w-2 rounded-full bg-dr3-chartreuse" aria-hidden="true" />
            All systems operational
          </span>
          <span className="text-xs text-dr3-cream/40">DR3-Vision · build {version}</span>
        </footer>
      </div>
    </main>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
