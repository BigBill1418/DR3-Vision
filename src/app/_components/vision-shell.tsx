// T-107 (ADR-0020) — branded Vision Dashboard shell.
//
// The product's front door. Keyed to the DR3-Vision logo
// (public/brand/dr3-vision-logo.jpg): a cyber "eye" in deep space. The shell
// renders that identity —
//   - a deep-space field (dr3-space) with a cyan nebula glow echoing the eye and
//     a faint starfield
//   - a header band: the Vision logo top-left + tagline + signed-in user info
//   - section labels (ACTIVE / COMING SOON) in cyan small-caps
//   - a footer: the health pill + build string
//
// Server component. Children are the rendered tile sections (the page composes
// them so this stays presentation-only).

import * as React from 'react';
import type { ReactNode } from 'react';
import { DashboardAvatar } from './dashboard-avatar';
import { HealthPill } from './health-pill';

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
    <main className="relative min-h-screen overflow-hidden bg-dr3-space text-dr3-mist">
      {/* ── deep-space atmosphere ─────────────────────────────────── */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {/* cyan nebula glow — the logo's eye, echoed into the field */}
        <div className="absolute -right-48 -top-48 h-[40rem] w-[40rem] rounded-full bg-dr3-cyan/10 blur-[150px]" />
        <div className="absolute -bottom-40 -left-40 h-[32rem] w-[32rem] rounded-full bg-dr3-steel/25 blur-[150px]" />
        {/* faint starfield */}
        <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(1px_1px_at_18%_28%,#ffffff66_1px,transparent_0),radial-gradient(1px_1px_at_72%_58%,#9ff3ea55_1px,transparent_0),radial-gradient(1px_1px_at_44%_82%,#ffffff3a_1px,transparent_0),radial-gradient(1px_1px_at_88%_22%,#ffffff4d_1px,transparent_0),radial-gradient(1px_1px_at_32%_64%,#7fe8de44_1px,transparent_0)] [background-size:340px_340px,280px_280px,220px_220px,190px_190px,150px_150px]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 sm:px-10 sm:py-12">
        {/* ── Header band ───────────────────────────────────────── */}
        <header className="flex flex-col gap-6 border-b border-dr3-steel-light/20 pb-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-3">
            <div className="relative w-fit">
              {/* soft halo so the logo's dark field melts into the page */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-10 scale-125 rounded-2xl bg-dr3-cyan/10 blur-2xl"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/dr3-vision-logo.jpg"
                alt="DR3 Vision"
                className="h-14 w-auto select-none rounded-xl ring-1 ring-dr3-steel-light/20 sm:h-[4.5rem]"
              />
            </div>
            <p className="pl-1 text-[11px] font-medium uppercase tracking-[0.35em] text-dr3-cyan/70">
              Operations · Compliance · Payroll
            </p>
          </div>
          <div className="flex items-center gap-3 text-right">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-dr3-mist">{userName}</span>
              <span className="text-xs text-dr3-mist-dim">
                {userEmail ?? '—'} · {role}
              </span>
            </div>
            <DashboardAvatar name={userName} />
          </div>
        </header>

        {/* ── Active section ────────────────────────────────────── */}
        <section className="pt-10">
          <h2 className="mb-4 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.3em] text-dr3-cyan">
            <span className="h-px w-6 bg-dr3-cyan/50" aria-hidden="true" />
            Active
          </h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {activeSection}
          </div>
        </section>

        {/* ── Coming soon section ───────────────────────────────── */}
        <section className="pt-12">
          <h2 className="mb-4 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.3em] text-dr3-mist-dim">
            <span className="h-px w-6 bg-dr3-mist-dim/40" aria-hidden="true" />
            Coming soon
          </h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {comingSoonSection}
          </div>
        </section>

        {/* ── Footer ────────────────────────────────────────────── */}
        <footer className="mt-auto flex flex-col gap-3 border-t border-dr3-steel-light/20 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <HealthPill />
          <span className="text-xs text-dr3-mist-dim/70">DR3-Vision · build {version}</span>
        </footer>
      </div>
    </main>
  );
}
