// ADR-0030 — Daily production report admin page (Bill-only via is_super_admin).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { listConfigs, listRecentSends } from '@/lib/bonus/daily-report-config';
import { SiteConfigCard } from './SiteConfigCard';
import { RecentSends } from './RecentSends';
import { HOME_ROUTE } from '@/lib/routes';

export const dynamic = 'force-dynamic';

export default async function ProductionReportAdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/admin/production-report');
  if (!session.user.is_super_admin) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-dr3-mist-dim">This area is restricted.</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:underline"
        >
          Back to dashboard
        </Link>
      </main>
    );
  }

  const configs = await listConfigs();
  const recent = await listRecentSends(null, 30);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/admin"
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:underline"
        >
          ← Back to admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Daily production report</h1>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Per-site configuration for the automated daily processing email. One site, one config, one
          daemon fire per Pacific calendar day with data.
        </p>

        <div className="mt-8 flex flex-col gap-4">
          {configs.map((c) => (
            <SiteConfigCard key={c.id} config={c} />
          ))}
        </div>

        <h2 className="mt-12 text-xl font-semibold">Recent sends</h2>
        <RecentSends rows={recent} />
      </div>
    </main>
  );
}
