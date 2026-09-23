// ADR-0135 F — the admin "possible duplicates" queue.
//
// Server component. Re-checks the admin gate exactly like `/admin/equipment`:
// merging (or declaring distinct) two records of a machine is a judgement about
// financial evidence, so it rides on `role === 'admin'` only — never on
// `all_sites` (CLAUDE.md hard rule #2). The routes it posts to re-check the same
// gate themselves.
//
// Reads `listPossibleDuplicates()` directly (the GET route serves the same list
// to API callers); sites come from `prisma.site` like every other admin page, and
// feed the cross-site "where does the survivor live?" choice.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { listPossibleDuplicates } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { DuplicatesClient } from './DuplicatesClient';

export const dynamic = 'force-dynamic';

export default async function AdminEquipmentDuplicatesPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/equipment/duplicates');
    return <ForbiddenPage />;
  }

  const [pairs, sites] = await Promise.all([
    listPossibleDuplicates(),
    prisma.site.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin/equipment"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.equipment.duplicatesBack}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.equipment.duplicatesTitle}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.equipment.duplicatesSubtitle}</p>
        </header>

        <DuplicatesClient pairs={pairs} sites={sites} />
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{M.forbiddenHeading}</h1>
      <p className="mt-2 text-dr3-mist-dim">{M.forbiddenBody}</p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
      >
        {M.backToDashboard}
      </Link>
    </main>
  );
}
