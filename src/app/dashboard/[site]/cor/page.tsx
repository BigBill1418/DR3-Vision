// ADR-0042 D4 — manager COR surface (Exhibit 5). Site-scoped (hard rule #2),
// CA-ONLY: a COR exists only in California, so the Oregon site 404s here (there is
// no Exhibit 5 to render). Desktop, English-first office surface (not an operator
// iPad). Forms are onClick, never <form> (hard rule #10).

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { CorClient } from './CorClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function CorPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/cor`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // CA-only surface: the Certificate of Recycling, Employment and Inventory is an
  // Exhibit-5 (California) document. An Oregon site has no COR — 404 (never render
  // an empty CA surface for an OR facility).
  const site = await prisma.site.findUnique({
    where: { id: result.ctx.siteId },
    select: { jurisdiction: true, max_units_indoor: true },
  });
  if (!site || site.jurisdiction !== 'california') notFound();

  // Capacity banner (D4, display-only): the CA facility's indoor storage limit is
  // the hard cap; warn at 90% (3,150 of Woodland's seeded 3,500). Derived from the
  // site config — never a hardcoded number.
  const capacityLimit = site.max_units_indoor ?? null;
  const capacityWarn = capacityLimit != null ? Math.floor(capacityLimit * 0.9) : null;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          &larr; Back to dashboard
        </Link>
        <h1 className="mt-4 text-3xl font-bold">
          Certificate of Recycling, Employment &amp; Inventory — {result.ctx.siteName}
        </h1>
        <p className="mt-2 max-w-3xl text-sm opacity-80">
          Exhibit 5 is <strong>pre-filled</strong> from Vision data — inventory from the running
          balance, headcount from the daily close. You review each number, enter the FT/PT split,
          then finalize. <strong>A human signs the printed copy</strong> — Vision never certifies.
        </p>
        <CorClient siteCode={siteCode} capacityLimit={capacityLimit} capacityWarn={capacityWarn} />
      </div>
    </main>
  );
}
