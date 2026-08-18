// ADR-0108 — where the "look at this load" line sits, and who can move it.
//
// Admin/management only. This is not a floor surface and must never become one:
// it is a tuning screen for a review aid, and the loads it governs are reference
// rows nobody is billed or paid from.
//
// The screen exists because the alternative is a constant in a file. The seeded
// numbers came from one revision of one workbook measured on one day; they are a
// starting point for Rick and Janette, not a finding. A line that needs a deploy
// to move is a line nobody moves, and it stops being a question somebody asked
// and starts being the definition of normal.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { listVarianceBounds } from '@/lib/doc-ingest/outbound-variance';
import { sitesWithOutboundCoverage } from '@/lib/doc-ingest/outbound-reconcile';
import { VarianceBoundsClient } from './VarianceBoundsClient';

export const dynamic = 'force-dynamic';

export default async function OutboundVariancePage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Outbound weight data is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const params = await searchParams;
  const sites = await sitesWithOutboundCoverage();
  const siteId = params.site ?? sites[0]?.id ?? null;
  const rows = siteId === null ? [] : await listVarianceBounds(siteId);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/admin/doc-ingest/outbound-coverage"
          className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
        >
          ← Outbound weight coverage
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Variance flag settings</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          Where the <strong>look-at-this</strong> line sits for each commodity. A load outside its
          commodity&apos;s range is marked on the coverage page so somebody goes and looks at it. No
          claim is made that the figure is wrong — <strong>nothing here knows that</strong> — and
          what a difference <em>means</em> is Bill&apos;s decision with Rick and Janette (ADR-0104
          §D10 · P-48). Nothing on this screen sends a message to anybody.
        </p>

        {sites.length > 1 && (
          <nav className="mt-4 flex flex-wrap gap-2 text-xs">
            {sites.map((s) => (
              <Link
                key={s.id}
                href={`/admin/doc-ingest/outbound-variance?site=${s.id}`}
                className={`rounded px-3 py-1 ring-1 ${
                  s.id === siteId
                    ? 'bg-dr3-cyan/20 text-dr3-cyan ring-dr3-cyan/40'
                    : 'text-dr3-mist-dim ring-dr3-steel-light/25'
                }`}
              >
                {s.name}
              </Link>
            ))}
          </nav>
        )}

        <div className="mt-6 rounded-lg bg-dr3-steel/20 p-4 text-xs text-dr3-mist-dim">
          <p>
            <strong className="text-dr3-mist">How the range is worked out.</strong> Each commodity
            has a typical weight and a <em>spread step</em> — a multiplier describing how far a
            normal load sits from that typical weight. The range is the typical weight divided and
            multiplied by that step, <em>k</em> times over. Six steps out is the starting point.
          </p>
          <p className="mt-2">
            The range is a <strong>ratio</strong> rather than a plus-or-minus in pounds on purpose.
            A load cannot weigh less than nothing, so a plus-or-minus band is squashed against zero
            on the low side and stops being able to flag a too-light load at all — for Wood, a
            symmetric band four steps wide could never have flagged the 40 lb row, which is exactly
            the kind of row this is for.
          </p>
          <p className="mt-2">
            A commodity with too few recorded loads is <strong>not flagged at all</strong>, and says
            so. Three loads cannot tell you what a normal load looks like, and a rule invented from
            three would be a guess wearing a number.
          </p>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-lg bg-dr3-steel/20 p-6 text-sm text-dr3-mist-dim">
            No commodity bands are configured for this site yet.
          </p>
        ) : (
          <VarianceBoundsClient rows={rows} />
        )}
      </div>
    </main>
  );
}
