// ADR-0042 D3 — Internal COR print source (Exhibit 5).
//
// This server component renders the printable Certificate of Recycling, Employment
// and Inventory. It is the *source* the Playwright generator (`@/lib/cor/pdf.ts`)
// navigates to and prints to PDF — NEVER a customer-facing route.
//
// AUTH MODEL: the generator runs headless with NO session, so this route relies on
// a loopback / origin guard: any request carrying a `cf-connecting-ip` header
// arrived through the public Cloudflare tunnel and is rejected with a flat 404
// (same pattern as /metrics and /internal/bonus-pdf). `/internal/cor-pdf/` is in
// the middleware public-paths allowlist so the auth middleware does not bounce the
// session-less generator to /login.
//
// SIGNING BOUNDARY (D3, verbatim): the certificate renders FROM the stored row and
// the signature block renders EMPTY — Vision never renders a signature, an
// "e-signed" mark, or anything that could be mistaken for certification. Rick
// prints, signs, and submits per the current MRC process.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';

// DR3 brand palette (CLAUDE.md hard rule #3): GREEN (#00524C primary) + BLACK.
// A CA MRC certificate is a DR3 document, so it wears the DR3 marks — NOT the
// SVdP-red payroll palette. All colors live here so no arbitrary hexes scatter.
const COR_THEME = {
  green: '#00524C', // DR3 primary green — headers, rules, labels
  greenDeep: '#00352F', // deeper green for the header band
  greenTint: '#EAF2F0', // pale green wash — section surfaces / zebra
  ink: '#1A1A1A', // near-black body text
  black: '#000000',
  white: '#FFFFFF',
  paper: '#FFFFFF',
  meta: '#5B6B67', // muted gray-green for footer/meta
  hairline: '#D6E2DF', // soft green-gray hairline
} as const;

function brandDataUri(file: string, mime: string): string {
  const bytes = readFileSync(join(process.cwd(), 'public', 'brand', file));
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const DR3_LOGO = brandDataUri('dr3-vision-logo.jpg', 'image/jpeg');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fmtMonth(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

function fmtTimestamp(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: 'America/Los_Angeles',
  }).format(d);
}

interface InventorySourceShape {
  asOf?: string;
  anchorSnapshotId?: string | null;
  computedTotal?: string;
}

export default async function CorPdfSourcePage({ params }: { params: Promise<{ id: string }> }) {
  // Loopback / origin guard: reject anything that traversed Cloudflare.
  const hdrs = await headers();
  if (hdrs.get('cf-connecting-ip') !== null) notFound();

  const { id } = await params;

  const cert = await prisma.corCertificate.findUnique({
    where: { id },
    include: { supersedes: { select: { version: true } } },
  });
  if (!cert) notFound();
  const site = await prisma.site.findUnique({
    where: { id: cert.site_id },
    select: { name: true },
  });
  if (!site) notFound();

  // ADR-0042 amendment — a mid-month filing prints inventory + FT/PT BLANK
  // (literally empty, matching Rick's hand-filed form): no value, no em-dash, no
  // "0"/"N/A". The end-of-month certificate renders exactly as before.
  const isMidMonth = cert.period === 'mid_month';

  const inv = (cert.inventory_source ?? {}) as InventorySourceShape;
  const ft = cert.ft_headcount;
  const pt = cert.pt_headcount;
  const totalHeadcount = ft != null && pt != null ? ft + pt : null;
  const generatedAt = new Date();
  const asOfLabel =
    !isMidMonth && inv.asOf
      ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date(inv.asOf),
        )
      : null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{`COR ${site.name} ${fmtMonth(cert.cover_month)} v${cert.version}`}</title>
        <style>{PRINT_CSS}</style>
      </head>
      <body>
        <div className="page">
          <header className="cor-head">
            <div className="brand">
              <div className="brand-chip">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="dr3-logo" src={DR3_LOGO} alt="DR3-Vision" />
              </div>
              <div className="brand-sub">DR3-Vision</div>
            </div>
            <div className="title-block">
              <h1>Certificate of Recycling, Employment and Inventory</h1>
              <p className="exhibit">Exhibit 5</p>
              <p className="subtitle">
                {site.name} &middot; {fmtMonth(cert.cover_month)} &middot;{' '}
                {isMidMonth ? 'Mid-month filing' : 'End-of-month close'}
              </p>
              {cert.status !== 'finalized' && (
                <p className="draft-marker">DRAFT — NOT FOR SUBMISSION</p>
              )}
            </div>
          </header>

          <section className="stmt">
            <p>
              This certificate reports the whole-unit inventory on hand at the close of the covered
              month and the facility employment for the period. Every reported figure is generated
              from DR3-Vision operational records; it is reviewed and signed by hand.
            </p>
          </section>

          <section className="figures">
            <div className="figure-row">
              <div className="figure-label">Unprocessed inventory at month close</div>
              <div className="figure-value">
                {isMidMonth || cert.inventory_units == null
                  ? ''
                  : `${cert.inventory_units.toLocaleString('en-US')} units`}
              </div>
            </div>
            {asOfLabel && <p className="figure-note">Running balance as of {asOfLabel}.</p>}

            <div className="figure-row">
              <div className="figure-label">Full-time employees</div>
              <div className="figure-value">
                {isMidMonth ? '' : ft != null ? ft.toLocaleString('en-US') : '—'}
              </div>
            </div>
            <div className="figure-row">
              <div className="figure-label">Part-time employees</div>
              <div className="figure-value">
                {isMidMonth ? '' : pt != null ? pt.toLocaleString('en-US') : '—'}
              </div>
            </div>
            <div className="figure-row figure-total">
              <div className="figure-label">Total employees</div>
              <div className="figure-value">
                {isMidMonth
                  ? ''
                  : totalHeadcount != null
                    ? totalHeadcount.toLocaleString('en-US')
                    : '—'}
              </div>
            </div>
          </section>
          {isMidMonth && (
            <p className="figure-note">
              Mid-month filing — inventory and employment figures are reported on the end-of-month
              certificate. These fields are intentionally left blank.
            </p>
          )}

          {/* D3 — EMPTY signature block. Vision renders NO signature/e-signed mark. */}
          <section className="signature">
            <div className="sig-line" />
            <div className="sig-meta">
              <div className="sig-name">{cert.signer_name}</div>
              <div className="sig-title">{cert.signer_title}</div>
            </div>
            <div className="sig-dateline">
              <span className="sig-date-blank" />
              <span className="sig-date-label">Date</span>
            </div>
            <p className="sig-note">
              Signature and date are completed by hand on the printed copy.
            </p>
          </section>

          <footer className="cor-foot">
            <span className="doc-id">
              COR {cert.id.slice(0, 8)} &middot; v{cert.version}
              {cert.supersedes ? ` (supersedes v${cert.supersedes.version})` : ''}
            </span>
            <span className="gen-at">Generated {fmtTimestamp(generatedAt)}</span>
          </footer>
        </div>
      </body>
    </html>
  );
}

const T = COR_THEME;
const PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: ${T.ink};
    background: ${T.paper};
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { padding: 40px 48px; max-width: 800px; margin: 0 auto; }
  .cor-head {
    display: flex; align-items: center; gap: 20px;
    padding-bottom: 16px;
    border-bottom: 3px solid ${T.green};
  }
  .brand { text-align: center; min-width: 120px; }
  .brand-chip {
    background: ${T.black}; border-radius: 10px; padding: 9px 12px;
    display: inline-flex; align-items: center; justify-content: center; border: 1px solid ${T.black};
  }
  .dr3-logo { height: 46px; width: auto; display: block; }
  .brand-sub { font-size: 11px; color: ${T.green}; font-weight: 700; margin-top: 6px; letter-spacing: 0.3px; }
  .title-block { flex: 1; }
  .title-block h1 { font-size: 21px; margin: 0 0 2px; color: ${T.black}; line-height: 1.2; }
  .exhibit { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 1px; color: ${T.green}; text-transform: uppercase; }
  .subtitle { font-size: 15px; margin: 6px 0 0; color: ${T.green}; font-weight: 600; }
  .draft-marker { margin: 8px 0 0; font-size: 13px; font-weight: 800; letter-spacing: 2px; color: ${T.black}; background: ${T.greenTint}; display: inline-block; padding: 2px 8px; border-radius: 4px; }
  .stmt { margin-top: 22px; font-size: 12.5px; line-height: 1.55; color: ${T.ink}; }
  .stmt p { margin: 0; }
  .figures { margin-top: 24px; border: 1px solid ${T.hairline}; border-radius: 8px; overflow: hidden; }
  .figure-row {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid ${T.hairline};
  }
  .figure-row:nth-child(odd) { background: ${T.greenTint}; }
  .figure-label { font-size: 13px; color: ${T.ink}; }
  .figure-value { font-size: 16px; font-weight: 700; color: ${T.green}; font-variant-numeric: tabular-nums; }
  .figure-total { border-bottom: none; border-top: 2px solid ${T.green}; }
  .figure-total .figure-label { font-weight: 700; color: ${T.black}; }
  .figure-note { margin: 6px 16px 0; font-size: 11px; color: ${T.meta}; font-style: italic; }
  .signature { margin-top: 46px; page-break-inside: avoid; }
  .sig-line { border-bottom: 1.5px solid ${T.black}; height: 40px; max-width: 360px; }
  .sig-meta { margin-top: 6px; }
  .sig-name { font-size: 15px; font-weight: 600; color: ${T.black}; }
  .sig-title { font-size: 12px; color: ${T.meta}; margin-top: 2px; }
  .sig-dateline { margin-top: 26px; display: flex; align-items: baseline; gap: 10px; max-width: 260px; }
  .sig-date-blank { flex: 1; border-bottom: 1.5px solid ${T.black}; height: 20px; }
  .sig-date-label { font-size: 12px; color: ${T.meta}; }
  .sig-note { margin-top: 10px; font-size: 10.5px; color: ${T.meta}; font-style: italic; }
  .cor-foot {
    display: flex; justify-content: space-between; margin-top: 40px;
    padding-top: 12px; border-top: 1px solid ${T.hairline};
    font-size: 10px; color: ${T.meta};
  }
  .doc-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media print { .page { padding: 0; } }
`;
