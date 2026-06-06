// Sprint-1 T-013 - manager-facing exports surface.
//
// Server component: resolves the session, decides which sites the
// caller can export from (admin: all; manager: their primary site
// only; operator: redirected to /dashboard).
//
// Renders the ExportsClient picker (client component) with the
// pre-resolved site list. The actual CSV download is a plain anchor
// that hits /api/exports/{mrc,svdp}; the page just composes the URL
// from the picker state. No `<form>` element per CLAUDE.md hard-rule
// #10.

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { ExportsClient, type SiteOption } from './ExportsClient';
import { BonusReports } from './BonusReports';
import { HOME_ROUTE } from '@/lib/routes';
import { checkBonusAccess } from '@/lib/bonus/access';
import { appCurrentYear } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function ExportsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  // Operators have no business on the exports page; redirect them to the
  // role-aware home (which routes them onward to /operator) rather than
  // render a 403 - the surface shouldn't even exist in their UX.
  if (session.user.role === 'operator') redirect(HOME_ROUTE);

  // Bonus reporting access is a distinct authorization (Woodland-scoped) from
  // the per-site export gate above: admins and Woodland/both-sites managers may
  // reach the bonus reports, Eugene (Rick) and operators may not. We surface the
  // bonus report entry points here only when this gate passes, mirroring every
  // /bonus page and /api/bonus route (single source: requireBonusAccess).
  const bonusGate = await checkBonusAccess();
  const showBonus = bonusGate.ok;

  const allSites = await prisma.site.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });

  // CLAUDE.md hard-rule #2: managers see their primary site only;
  // admins see every site.
  const visibleSites: SiteOption[] =
    session.user.role === 'admin'
      ? allSites.map((s) => ({ code: s.code, name: s.name }))
      : allSites
          .filter((s) => s.id === session.user.primary_site_id)
          .map((s) => ({ code: s.code, name: s.name }));

  // No sites assigned (manager without primary_site_id, edge case):
  // render a friendly "ask an admin" instead of an empty picker.
  if (visibleSites.length === 0) {
    return (
      <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <PageHeader name={session.user.name ?? 'Manager'} role={session.user.role} />
          <p className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-3 text-dr3-mist-dim">
            No sites are currently assigned to your account. Ask an admin to set your primary site
            before generating exports.
          </p>
          {showBonus ? <BonusReports year={appCurrentYear()} /> : null}
          <BackLink />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <PageHeader name={session.user.name ?? 'Manager'} role={session.user.role} />
        <ExportsClient sites={visibleSites} />
        {showBonus ? <BonusReports year={appCurrentYear()} /> : null}
        <BackLink />
      </div>
    </main>
  );
}

function PageHeader({ name, role }: { name: string; role: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-3xl font-bold tracking-tight">Monthly exports</h1>
      <p className="text-sm text-dr3-mist-dim">
        Signed in as <span className="font-semibold">{name}</span>{' '}
        <span className="capitalize">({role})</span>
      </p>
    </header>
  );
}

function BackLink() {
  return (
    <Link
      href={HOME_ROUTE}
      className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
    >
      Back to dashboard
    </Link>
  );
}
