// ADR-0037 D5 — processed_units_daily admin page (office desktop, SUPER-ADMIN).
//
// This is the number billing bills from. Distinct from the iPad operator flow
// (untouched) and from the per-processor bonus daily entries (payroll). Mirrors
// the ADR-0030 daily-production-report admin page's super-admin gate + layout.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { HOME_ROUTE } from '@/lib/routes';
import { ProcessedUnitsClient } from './ProcessedUnitsClient';

export const dynamic = 'force-dynamic';

export default async function ProcessedUnitsAdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/admin/processed-units');
  if (!session.user.is_super_admin) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-dr3-mist-dim">This area is restricted.</p>
        <Link href={HOME_ROUTE} className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const sites = await prisma.site.findMany({ orderBy: { code: 'asc' }, select: { code: true, name: true } });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto max-w-4xl">
        <Link href="/admin" className="text-sm text-dr3-mist-dim underline-offset-4 hover:underline">
          ← Back to admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Processed units (daily close)</h1>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          The billing basis (ADR-0037 D5): stripped units per site per day, split program vs. non-program, plus
          the daily-close metadata (saved, material ticket #, headcount, pocketcoil). Closing a day locks it;
          corrections after close follow the amendment path, never an in-place edit.
        </p>
        <ProcessedUnitsClient sites={sites} />
      </div>
    </main>
  );
}
