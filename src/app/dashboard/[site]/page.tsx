import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';

// Per-site dashboard placeholder. T-005+ replaces this with the live
// dock view, load list, and compliance dashboard. For T-003 it
// enforces the SPRINT-1-PLAN T-003 acceptance criterion: a manager
// scoped to one site gets a 403 on any other site, and an admin can
// reach both.

type Props = { params: Promise<{ site: string }> };

export default async function SiteDashboardPage({ params }: Props) {
  const { site: siteCode } = await params;
  const session = await auth();
  if (!session?.user) redirect('/login');

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true, jurisdiction: true },
  });
  if (!site) notFound();

  const isAdmin = session.user.role === 'admin';
  const isAssigned = session.user.primary_site_id === site.id;
  if (!isAdmin && !isAssigned) {
    // Per acceptance: a manager scoped to Eugene hitting /dashboard/woodland
    // sees a 403, not a redirect or a misleading 404.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
        <h1 className="text-2xl font-semibold">403 — not authorized for this site</h1>
        <p className="mt-2 text-dr3-cream/70">You don&apos;t have access to {site.name}.</p>
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
        >
          Back to your sites
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <Link
          href="/dashboard"
          className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
        >
          ← All sites
        </Link>
        <header>
          <h1 className="text-3xl font-bold tracking-tight">{site.name}</h1>
          <p className="text-sm capitalize text-dr3-cream/70">{site.jurisdiction}</p>
        </header>
        <p className="text-dr3-cream/80">
          Operator queue, dock view, and compliance dashboard ship in T-005+. This is the T-003
          access-control checkpoint.
        </p>
      </div>
    </main>
  );
}

export async function generateStaticParams() {
  // Per-site routes are server-rendered (auth-gated); no static gen.
  return [];
}
