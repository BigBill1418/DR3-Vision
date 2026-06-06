'use client';

// Sprint-1 T-013 - client-side exports picker.
//
// Per CLAUDE.md hard-rule #10 the inputs are bare inputs and the
// downloads are anchor tags - NOT a `<form>` element. State updates
// rebuild the anchor href.

import { useMemo, useState } from 'react';

export interface SiteOption {
  code: string;
  name: string;
}

interface Props {
  sites: SiteOption[];
}

function defaultMonth(): string {
  // YYYY-MM in the browser's local zone. The export's date semantics
  // are UTC server-side (see exports.ts monthRange) but the picker
  // shows the operator's local "current month" for ergonomics.
  const d = new Date();
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

export function ExportsClient({ sites }: Props) {
  const initialSiteCode = sites[0]?.code ?? '';
  const [siteCode, setSiteCode] = useState<string>(initialSiteCode);
  const [month, setMonth] = useState<string>(defaultMonth);

  const ready = siteCode.length > 0 && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

  const params = useMemo(() => {
    const sp = new URLSearchParams({ site: siteCode, month });
    return sp.toString();
  }, [siteCode, month]);

  const mrcHref = ready ? `/api/exports/mrc?${params}` : undefined;
  const svdpHref = ready ? `/api/exports/svdp?${params}` : undefined;

  return (
    <section className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-dr3-mist-dim">Site</span>
          {sites.length === 1 ? (
            <span
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-2 text-dr3-mist"
              data-testid="exports-site-fixed"
            >
              {sites[0]!.name}
            </span>
          ) : (
            <select
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
              value={siteCode}
              onChange={(e) => setSiteCode(e.target.value)}
              data-testid="exports-site-select"
            >
              {sites.map((s) => (
                <option key={s.code} value={s.code} className="text-dr3-ink">
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-dr3-mist-dim">Month</span>
          <input
            type="month"
            className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            data-testid="exports-month-input"
          />
        </label>
      </div>

      <div className="flex flex-col gap-4">
        <DownloadCard
          title="MRC Monthly Invoice (Article 10.4)"
          href={mrcHref}
          filename={ready ? `dr3-mrc-invoice-${siteCode}-${month}.csv` : 'dr3-mrc-invoice-...csv'}
          helper="One row per submitted, verified, submitted-to-MyMRC, or processed inbound load for the selected site and month. Column shape matches the MyMRC reconciliation CSV."
          dataTestId="download-mrc"
        />
        <DownloadCard
          title="SVdP Internal CSV"
          href={svdpHref}
          filename={
            ready ? `dr3-svdp-internal-${siteCode}-${month}.csv` : 'dr3-svdp-internal-...csv'
          }
          helper="Same row criteria as the MRC export, plus DR3 Load ID, arrival timestamp, unload duration, and operator. Per ADR-0012 §7 - reshape after Glenn DePrater conversation."
          dataTestId="download-svdp"
        />
      </div>
    </section>
  );
}

interface CardProps {
  title: string;
  helper: string;
  href: string | undefined;
  filename: string;
  dataTestId: string;
}

function DownloadCard({ title, helper, href, filename, dataTestId }: CardProps) {
  const enabled = !!href;
  const baseClasses =
    'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors';
  const enabledClasses = 'bg-dr3-cyan text-dr3-space hover:bg-dr3-cyan-bright';
  const disabledClasses = 'cursor-not-allowed bg-dr3-space text-dr3-mist-dim/60';

  return (
    <article className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-dr3-mist">{title}</h2>
        <p className="text-xs text-dr3-mist-dim">{helper}</p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <code className="break-all text-xs text-dr3-mist-dim">{filename}</code>
        {enabled ? (
          <a
            href={href}
            download={filename}
            className={`${baseClasses} ${enabledClasses}`}
            data-testid={dataTestId}
          >
            Download CSV
          </a>
        ) : (
          <span
            aria-disabled="true"
            className={`${baseClasses} ${disabledClasses}`}
            data-testid={`${dataTestId}-disabled`}
          >
            Download CSV
          </span>
        )}
      </div>
    </article>
  );
}
