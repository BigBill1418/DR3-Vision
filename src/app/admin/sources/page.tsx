// ADR-0125 (Phase 0 gap G-3) — the collection-source classifier surface.
//
// Four columns on `sources` decide money, and until this page none of them had a
// human write path: `is_trans_charge` (which of the workbook's two inbound tabs a
// haul belongs to, and whether the CA freight leg bills it), `is_non_program`
// (which POOL its units land in — MRC is billed on the program pool),
// `canonical_mileage` (the `miles` input to the fuel-surcharge formula) and
// `haul_assignment` (new here, G-9 — which haul-rate leg applies).
//
// Admin-role only per hard rule #2: these are admin POWERS, not site reach, so
// `all_sites` does not unlock them.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { listSourceClassifications } from '@/lib/sources/admin';
import { SourcesClient } from './SourcesClient';

export const dynamic = 'force-dynamic';

export default async function AdminSourcesPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/sources');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{AM.forbiddenHeading}</h1>
        <p className="mt-2 text-dr3-mist-dim">{AM.forbiddenBody}</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          Back
        </Link>
      </main>
    );
  }

  const rows = await listSourceClassifications({ limit: 500 });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link
          href={HOME_ROUTE}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          ← {AM.backToDashboard}
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Collection sources</h1>
        <p className="mt-2 max-w-3xl text-sm text-dr3-mist-dim">
          The four classifiers that decide how a source is billed. <strong>Trans charge</strong>{' '}
          splits the two inbound tabs and is what the CA freight leg selects on.{' '}
          <strong>Non-program</strong> decides which pool a load&apos;s units land in — MRC is
          billed on the program pool. <strong>Mileage</strong> is the miles input to the
          fuel-surcharge formula. <strong>Haul assignment</strong> selects the haul-rate leg. Every
          change is audited.
        </p>
        <SourcesClient rows={rows} />
      </div>
    </main>
  );
}
