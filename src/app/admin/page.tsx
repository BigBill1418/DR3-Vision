// /admin — admin hub. Was a bare redirect to /admin/users; ADR-0040 D5 turns it
// into a small gated tile launcher so the new Billing rates surface is
// discoverable alongside User management and the Audit log. Admin-only, matching
// the ADR-0020 launcher's `admin-only` scope for the "Admin & Audit" tile; the
// billing-rate pages gate independently (manager+ read) so a rate-manager can
// still reach them by direct link.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';

export const dynamic = 'force-dynamic';

const TILES = [
  {
    href: '/admin/users',
    label: 'User management',
    description: 'Seed and manage operators, managers, and admins for both sites.',
    testid: 'admin-tile-users',
  },
  {
    href: '/admin/audit',
    label: 'Audit log',
    description: 'Append-only record of every mutation. Read-only and retained indefinitely.',
    testid: 'admin-tile-audit',
  },
  {
    href: '/admin/billing-rates',
    label: 'Billing rates',
    description: 'Transport tiers, account haul overrides, container rentals, and fuel prices.',
    testid: 'admin-tile-billing-rates',
  },
  {
    href: '/admin/rollout',
    label: 'Rollout gate',
    description: 'Pilot→live control for every staff-facing surface × site (ADR-0047). Flip to ramp; audited.',
    testid: 'admin-tile-rollout',
  },
] as const;

export default async function AdminIndexPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{AM.forbiddenHeading}</h1>
        <p className="mt-2 text-dr3-mist-dim">{AM.forbiddenBody}</p>
        <Link href={HOME_ROUTE} className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
          {AM.backToDashboard}
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link href={HOME_ROUTE} className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
            ← {AM.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
          <p className="text-sm text-dr3-mist-dim">User management, the append-only audit log, and billing rates.</p>
        </header>
        <section className="grid gap-4 sm:grid-cols-2">
          {TILES.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              data-testid={t.testid}
              className="group flex flex-col gap-2 rounded-2xl border border-dr3-steel-light/25 bg-dr3-space-2/70 p-6 transition-colors hover:border-dr3-cyan/50"
            >
              <h2 className="text-lg font-semibold text-dr3-mist">{t.label}</h2>
              <p className="text-sm leading-relaxed text-dr3-mist-dim">{t.description}</p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-dr3-cyan">
                Open
                <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                  →
                </span>
              </span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
