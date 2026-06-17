// Bonus reporting entry points for the Reports/Exports area (T-013 follow-up,
// 2026-06-06).
//
// PRESENTATION ONLY — pure server component, no auth/prisma. The Exports page
// resolves `checkBonusAccess()` and renders this *only* when the caller may
// reach bonus reporting (admin OR Woodland/both-sites manager). It links out to
// the existing /bonus surfaces and the existing annual CSV export route; it does
// NOT re-implement any bonus reporting. Voice + brand match the Exports download
// cards on the same page.

import * as React from 'react';
import Link from 'next/link';

export function BonusReports({ year }: { year: number }) {
  return (
    <section className="flex flex-col gap-4" data-testid="bonus-reports">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Bonus reports</h2>
        <p className="text-sm text-dr3-mist-dim">
          Woodland processor bonus reporting. Figures match the daily grid and the signed monthly
          PDF.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <ReportCard
          title="Monthly bonus reports"
          helper="Browse every bonus month — open a month for the read-only grid, signature panel, and the signed payroll PDF export."
          href="/bonus/months"
          linkLabel="Open monthly reports"
          dataTestId="bonus-report-months"
        />
        <ReportCard
          title="Annual bonus aggregate"
          helper={`Per-processor year-to-date totals for ${year}. Pick a year on the page; export the displayed year as CSV.`}
          href="/bonus/annual"
          linkLabel="Open annual summary"
          dataTestId="bonus-report-annual"
          secondary={{
            href: `/api/bonus/annual/export?year=${year}`,
            label: `Export ${year} CSV`,
            download: `bonus-annual-${year}.csv`,
            dataTestId: 'bonus-report-annual-csv',
          }}
        />
        <ReportCard
          title="Current pay period — live standings"
          helper="Where every processor stands RIGHT NOW in the open pay period: units so far, days qualified, days short of the minimum, and bonus accrued. Tap a processor for their full cross-period history."
          href="/bonus/standings"
          linkLabel="Open live standings"
          dataTestId="bonus-report-standings"
        />
      </div>
    </section>
  );
}

interface ReportCardProps {
  title: string;
  helper: string;
  href: string;
  linkLabel: string;
  dataTestId: string;
  secondary?: { href: string; label: string; download: string; dataTestId: string };
}

function ReportCard({ title, helper, href, linkLabel, dataTestId, secondary }: ReportCardProps) {
  const baseClasses =
    'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors';
  return (
    <article className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold text-dr3-mist">{title}</h3>
        <p className="text-xs text-dr3-mist-dim">{helper}</p>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={href}
          className={`${baseClasses} bg-dr3-cyan text-dr3-space hover:bg-dr3-cyan-bright`}
          data-testid={dataTestId}
        >
          {linkLabel}
        </Link>
        {secondary ? (
          <a
            href={secondary.href}
            download={secondary.download}
            className={`${baseClasses} border border-dr3-steel-light/40 text-dr3-mist hover:bg-dr3-steel/40`}
            data-testid={secondary.dataTestId}
          >
            {secondary.label}
          </a>
        ) : null}
      </div>
    </article>
  );
}
