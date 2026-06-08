// T-112 — Internal PDF source page (ADR-0019 §10).
//
// This server component renders the printable, co-branded monthly bonus report.
// It is the *source* the Playwright generator (`@/lib/bonus/pdf.ts`) navigates to
// and prints to PDF — it is NEVER a customer-facing route.
//
// AUTH MODEL: the generator runs headless with NO session, so this route cannot
// use `requireBonusAccess()`. Instead it relies on a loopback / origin guard:
// any request carrying a `cf-connecting-ip` header arrived through the public
// Cloudflare tunnel and is rejected with a flat 404 (same pattern as /metrics,
// T-109). Only the in-fleet Playwright generator hitting localhost reaches the
// render path. The orchestrator must also add `/internal/bonus-pdf` to the
// middleware public-paths allowlist so the auth middleware does not bounce the
// session-less generator to /login (see middlewareIntegration in the handoff).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import { formatCents } from '@/lib/bonus/calculator';
import {
  assemblePdfRows,
  buildAttestation,
  formatPeriodTitle,
  type AttestationSource,
  type PdfEntry,
} from '@/lib/bonus/pdf-data';
import { getSignatureChain } from '@/lib/bonus/signature-chain';

// Red/black payroll palette (ADR-0023). A print/payroll document is deliberately
// styled in deep SVdP red + black on white — NOT the app's dark-cyan dashboard
// theme. All colors live here so no arbitrary hexes are scattered through the CSS.
const PAYROLL_THEME = {
  red: '#B91C2C', // deep SVdP-style crimson — headers, accents, grand total
  redDark: '#8A1420', // darker red for the table-header band gradient + rules
  redTint: '#FBEAEC', // pale red wash — table zebra + tint surfaces
  ink: '#1A1A1A', // near-black body text
  black: '#000000', // pure black for the primary header rule
  white: '#FFFFFF',
  paper: '#FFFFFF',
  meta: '#6B7280', // muted gray for signature/footer meta
  hairline: '#E2D6D8', // soft red-gray hairline for table rows / footer
} as const;

/**
 * Read a brand asset off disk and return it as a base64 data URI. Inlining keeps
 * the printable page fully self-contained so the headless render never races a
 * /public fetch during `networkidle` and the PDF carries the logos as bytes.
 */
function brandDataUri(file: string, mime: string): string {
  const bytes = readFileSync(join(process.cwd(), 'public', 'brand', file));
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

// Official St. Vincent de Paul seal sourced from svdp.us
// (https://www.svdp.us/wp-content/uploads/2021/09/SVdP-favico.png) — red/black/white
// on transparent, reads crisply on a white payroll document. The DR3-Vision brand
// logo is dark-background/cyan-accented, so it sits on a small black chip in-header.
const SVDP_LOGO = brandDataUri('svdp-logo-official.png', 'image/png');
const DR3_LOGO = brandDataUri('dr3-vision-logo.jpg', 'image/jpeg');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SignatureBlock {
  label: string;
  /** Source-adapted attestation lines (T-209): primary / manual / auto override. */
  attestationLines: string[];
  attestationSource: AttestationSource;
  /** Name printed on the signature line (the actual signer or override actor). */
  signedName: string | null;
  signedRole: string;
  signedAt: Date | null;
  signedIp: string | null;
  signedUserAgent: string | null;
}

function fmtTimestamp(d: Date | null): string {
  if (!d) return '—';
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

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export default async function BonusPdfSourcePage({
  params,
}: {
  params: Promise<{ 'month-id': string }>;
}) {
  // Loopback / origin guard: reject anything that traversed Cloudflare.
  const hdrs = await headers();
  if (hdrs.get('cf-connecting-ip') !== null) notFound();

  const { 'month-id': monthId } = await params;

  const month = await prisma.bonusPayPeriod.findUnique({
    where: { id: monthId },
    include: {
      site: { select: { code: true, name: true } },
      facility_signed_by: { select: { name: true } },
      ops_signed_by: { select: { name: true } },
      // ADR-0023 Q13 / T-321: for historical_imported periods we print the
      // as-paid legacy total + an import-specific attestation; both need the
      // source filename + SHA-256 from the import session.
      bonus_import: {
        select: { source_filename: true, source_sha256: true, imported_at: true },
      },
    },
  });
  if (!month) notFound();

  // ADR-0023 Q1/Q4/Q13 (T-321): historical_imported periods are loaded from the
  // legacy spreadsheet — they were never live-signed. They print:
  //   (a) the AS-PAID legacy total when imported_with_legacy_formula is set
  //       (legacy_total_payout_cents), NOT the recomputed/corrected total; and
  //   (b) an import-specific attestation naming the source workbook + SHA-256,
  //       explicitly stating the report is NOT facility/ops-signed.
  // Live signed periods (every other state) keep the unchanged signed flow below.
  const isHistorical = month.state === 'historical_imported';

  // Employees + entries for this month.
  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_pay_period_id: month.id },
    select: { bonus_employee_id: true, entry_date: true, mattress_count: true },
  });
  const employees = await prisma.bonusEmployee.findMany({
    where: { site_id: month.site_id },
    select: { id: true, full_name: true },
  });

  // Rule effective at the month's start drives the math (CLAUDE.md hard rule #3).
  const rule = await resolveActiveRule(month.site_id, month.period_start);

  const data = assemblePdfRows({
    month: {
      id: month.id,
      site_id: month.site_id,
      period_start: month.period_start,
      period_end: month.period_end,
      state: month.state,
      total_payout_cents: month.total_payout_cents,
      amended_from_period_id: month.amended_from_period_id,
      period_number: month.period_number,
      period_year: month.period_year,
      pay_date: month.pay_date,
    },
    site: { code: month.site.code, name: month.site.name },
    employees,
    entries: entries as PdfEntry[],
    rule,
  });

  // Grand total printed in the table footer. For a historical_imported period the
  // ADR-0023 Q1 rule applies: print the AS-PAID legacy total (the spreadsheet's
  // threshold_high=75 figure stored at import) when imported_with_legacy_formula
  // is set, falling back to the stored corrected total; never the recomputed
  // (corrected-formula) figure from assemblePdfRows. Live periods keep the
  // calculator-derived grand total so screen / PDF / CSV can never diverge.
  const displayTotalCents = isHistorical
    ? month.imported_with_legacy_formula
      ? (month.legacy_total_payout_cents ?? month.total_payout_cents ?? data.grandTotalCents)
      : (month.total_payout_cents ?? data.grandTotalCents)
    : data.grandTotalCents;

  // T-209 title block — site-name driven, bi-weekly period naming (ADR-0019.1 §1).
  const periodTitle = formatPeriodTitle({
    siteName: month.site.name,
    periodNumber: month.period_number,
    periodYear: month.period_year,
    periodStart: month.period_start,
    periodEnd: month.period_end,
    payDate: month.pay_date,
  });

  // Resolve the site's natural signers + the auto-override actor from the
  // signature chain (read-only; the chain is the single source of truth for
  // "who signs which slot at which site" — addendum hard rule #2). Override
  // attestation reads "on behalf of <natural signer>" for the slot.
  const chain = await getSignatureChain(month.site_id);

  // Collect every user UUID we must turn into a display name in one query:
  // manual override actors, the configured auto-override actor, and the natural
  // (chain) signers for each slot.
  const nameLookupIds = [
    month.facility_override_actor_id,
    month.ops_override_actor_id,
    chain.auto_override_actor_user_id,
    chain.facility_signer_user_id,
    chain.ops_signer_user_id,
  ].filter((v): v is string => typeof v === 'string');
  const lookedUpUsers = nameLookupIds.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(nameLookupIds)] } },
        select: { id: true, name: true },
      })
    : [];
  const userName = (id: string | null): string | null =>
    id ? (lookedUpUsers.find((u) => u.id === id)?.name ?? id) : null;

  const facilityRole = 'Facility Manager';
  const opsRole = 'Operations Manager';

  const facilityAttest = buildAttestation(
    {
      slotRole: facilityRole,
      primarySignerName: month.facility_signed_by?.name ?? null,
      overrideActorName: userName(month.facility_override_actor_id),
      overrideReason: month.facility_override_reason,
      autoOverrideAt: month.facility_auto_override_at,
      autoOverrideActorName: userName(chain.auto_override_actor_user_id),
      naturalSignerName: userName(chain.facility_signer_user_id),
    },
    'I attest that the mattress counts and processor bonuses reported above are accurate for the period shown.',
  );

  const opsAttest = buildAttestation(
    {
      slotRole: opsRole,
      primarySignerName: month.ops_signed_by?.name ?? null,
      overrideActorName: userName(month.ops_override_actor_id),
      overrideReason: month.ops_override_reason,
      autoOverrideAt: month.ops_auto_override_at,
      autoOverrideActorName: userName(chain.auto_override_actor_user_id),
      naturalSignerName: userName(chain.ops_signer_user_id),
    },
    'I attest that I have reviewed and approve the processor bonuses reported above for payroll.',
  );

  // Name printed on the signature line: the override actor if overridden,
  // otherwise the primary signer.
  const facilitySignedName =
    facilityAttest.source === 'auto_override'
      ? userName(chain.auto_override_actor_user_id)
      : facilityAttest.source === 'manual_override'
        ? userName(month.facility_override_actor_id)
        : (month.facility_signed_by?.name ?? null);
  const opsSignedName =
    opsAttest.source === 'auto_override'
      ? userName(chain.auto_override_actor_user_id)
      : opsAttest.source === 'manual_override'
        ? userName(month.ops_override_actor_id)
        : (month.ops_signed_by?.name ?? null);

  // ADR-0023 Q4/Q13 (T-321): a historical_imported period was loaded from the
  // legacy workbook and was NEVER live-signed — printing the facility/ops
  // signature slots (all empty, "not signed") would misrepresent it as an
  // unsigned-but-expected report. Replace the two signer blocks with one
  // import-provenance attestation that names the source file + SHA-256 and
  // states plainly that it is not facility/ops-signed.
  const importSourceFile = month.bonus_import?.source_filename ?? 'the historical workbook';
  const importSha = month.bonus_import?.source_sha256 ?? null;
  const importShaLabel = importSha ? `SHA-256 ${importSha.slice(0, 12)}…` : 'SHA-256 unavailable';
  const importAttestationLines = [
    `Imported from ${importSourceFile} ${importShaLabel}, not signed by facility or ops.`,
    `Historical record — as-paid totals from the legacy spreadsheet (ADR-0023). No live attestation exists for this period.`,
  ];

  const signatures: SignatureBlock[] = isHistorical
    ? [
        {
          label: 'Historical Import',
          attestationLines: importAttestationLines,
          attestationSource: 'unsigned',
          signedName: null,
          signedRole: 'Historical Import (not signed)',
          signedAt: month.bonus_import?.imported_at ?? null,
          signedIp: null,
          signedUserAgent: null,
        },
      ]
    : [
        {
          label: facilityRole,
          attestationLines: facilityAttest.lines,
          attestationSource: facilityAttest.source,
          signedName: facilitySignedName,
          signedRole: facilityRole,
          signedAt: month.facility_signed_at,
          signedIp: month.facility_signed_ip,
          signedUserAgent: month.facility_signed_user_agent,
        },
        {
          label: opsRole,
          attestationLines: opsAttest.lines,
          attestationSource: opsAttest.source,
          signedName: opsSignedName,
          signedRole: opsRole,
          signedAt: month.ops_signed_at,
          signedIp: month.ops_signed_ip,
          signedUserAgent: month.ops_signed_user_agent,
        },
      ];

  const generatedAt = new Date();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{data.documentId}</title>
        <style>{PRINT_CSS}</style>
      </head>
      <body>
        <div className="page">
          <header className="report-head">
            <div className="brand brand-left">
              <div className="brand-chip">
                {/* next/image is unavailable in this standalone <html> print doc
                    rendered by Playwright; the logo is an inlined data URI. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="dr3-logo" src={DR3_LOGO} alt="DR3-Vision" />
              </div>
              <div className="brand-sub">DR3-Vision</div>
            </div>
            <div className="title-block">
              {/* T-209: bi-weekly, site-name-driven title (ADR-0019.1 §1). The
                  "DR3 " prefix is owned by the title template; formatPeriodTitle
                  strips the seeded prefix from site.name to avoid doubling it. */}
              <h1>{periodTitle.title}</h1>
              <p className="subtitle">{periodTitle.payDateLine}</p>
              {data.isAmended && (
                <>
                  <p className="amended-marker">AMENDED</p>
                  <p className="amended-note">
                    This report supersedes the prior version emailed on{' '}
                    {fmtDate(month.payroll_sent_at)}.
                  </p>
                </>
              )}
            </div>
            <div className="brand brand-right">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="svdp-logo" src={SVDP_LOGO} alt="St. Vincent de Paul" />
              <div className="brand-sub">St. Vincent de Paul</div>
            </div>
          </header>

          <table className="bonus-table">
            <thead>
              <tr>
                <th className="col-name">Employee</th>
                <th className="col-num">Days Qualified</th>
                <th className="col-num">Total Mattresses</th>
                <th className="col-num">Total Bonus</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.employeeId}>
                  <td className="col-name">{r.name}</td>
                  <td className="col-num">{r.daysQualified}</td>
                  <td className="col-num">{r.totalMattresses}</td>
                  <td className="col-num">{formatCents(r.totalBonusCents)}</td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td className="col-name" colSpan={4}>
                    No qualifying entries for this month.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="col-name grand-label" colSpan={3}>
                  Period Grand Total
                </td>
                <td className="col-num grand-total">{formatCents(displayTotalCents)}</td>
              </tr>
            </tfoot>
          </table>

          <section className="signatures">
            {signatures.map((s) => (
              <div className="sig-block" key={s.label}>
                <div className="sig-attest">
                  {s.attestationLines.map((line, i) => (
                    <p
                      key={i}
                      className={
                        i === 0 ? 'sig-attest-line' : 'sig-attest-line sig-attest-secondary'
                      }
                    >
                      {line}
                    </p>
                  ))}
                </div>
                <div className="sig-line">
                  <span className="sig-name">{s.signedName ?? '— not signed —'}</span>
                </div>
                <div className="sig-meta">
                  <div>{s.signedRole}</div>
                  <div>Signed: {fmtTimestamp(s.signedAt)}</div>
                  <div>IP: {s.signedIp ?? '—'}</div>
                  <div className="sig-ua">UA: {s.signedUserAgent ?? '—'}</div>
                </div>
              </div>
            ))}
          </section>

          <footer className="report-foot">
            <span className="doc-id">{data.documentId}</span>
            <span className="gen-at">Generated {fmtTimestamp(generatedAt)}</span>
          </footer>
        </div>
      </body>
    </html>
  );
}

// Inline, print-friendly CSS in the RED/BLACK payroll palette (ADR-0023).
// Self-contained so the headless render needs no external stylesheet (Tailwind
// isn't reliably present for a route that renders a full <html> document outside
// the app shell). Every color comes from PAYROLL_THEME — no scattered hexes.
const T = PAYROLL_THEME;
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
  .page { padding: 32px 40px; max-width: 800px; margin: 0 auto; }
  /* Black header divider with a thin red accent rule layered directly beneath it
     (box-shadow keeps the red flush under the black border, never floating across
     the wrapped title). */
  .report-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding-bottom: 16px;
    border-bottom: 3px solid ${T.black};
    box-shadow: 0 3px 0 0 ${T.red};
  }
  .brand { text-align: center; min-width: 132px; }
  /* DR3-Vision brand logo is dark/cyan-accented art — seat it on a black chip so
     it reads crisply against the white payroll page without recoloring it. */
  .brand-chip {
    background: ${T.black}; border-radius: 10px; padding: 9px 12px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid ${T.black};
  }
  .dr3-logo { height: 46px; width: auto; display: block; }
  .svdp-logo { height: 66px; width: auto; display: block; margin: 0 auto; }
  .brand-sub { font-size: 11px; color: ${T.red}; font-weight: 700; margin-top: 6px;
    letter-spacing: 0.3px; }
  .title-block { flex: 1; text-align: center; }
  .title-block h1 { font-size: 20px; margin: 0 0 4px; color: ${T.black}; }
  .subtitle { font-size: 14px; margin: 0; color: ${T.red}; font-weight: 600; }
  .amended-marker {
    margin: 8px 0 2px; font-size: 16px; font-weight: 800; letter-spacing: 2px;
    color: ${T.red};
  }
  .amended-note { margin: 0; font-size: 11px; color: ${T.meta}; font-style: italic; }
  .bonus-table { width: 100%; border-collapse: collapse; margin-top: 22px; }
  .bonus-table th, .bonus-table td {
    border-bottom: 1px solid ${T.hairline}; padding: 7px 12px; font-size: 13px;
  }
  .bonus-table thead th {
    background: ${T.red}; color: ${T.white}; text-align: left; border-bottom: none;
    font-weight: 700; letter-spacing: 0.2px;
  }
  .bonus-table tbody tr:nth-child(even) { background: ${T.redTint}; }
  .col-num { text-align: right; }
  th.col-num { text-align: right; }
  .bonus-table tfoot td {
    border-top: 2px solid ${T.black}; border-bottom: none; font-weight: 800;
    padding-top: 11px; font-size: 14px;
  }
  .grand-label { text-align: right; color: ${T.black}; }
  .grand-total { color: ${T.red}; }
  .signatures { display: flex; gap: 32px; margin-top: 30px; page-break-inside: avoid; }
  .sig-block { flex: 1; page-break-inside: avoid; }
  .sig-attest { font-size: 11px; color: ${T.ink}; min-height: 30px; }
  .sig-attest-line { margin: 0 0 4px; font-size: 11px; line-height: 1.4; }
  /* Override / system-override explanatory sentences read in red so payroll sees
     immediately that the slot was not primary-signed. */
  .sig-attest-secondary { color: ${T.red}; font-weight: 600; font-style: italic; }
  .sig-line { border-bottom: 1px solid ${T.black}; margin: 22px 0 6px; padding-bottom: 4px; }
  .sig-name { font-size: 15px; font-weight: 600; color: ${T.black}; }
  .sig-meta { font-size: 10px; color: ${T.meta}; line-height: 1.5; }
  .sig-ua { word-break: break-all; }
  .report-foot {
    display: flex; justify-content: space-between; margin-top: 28px;
    padding-top: 12px; border-top: 1px solid ${T.hairline};
    font-size: 10px; color: ${T.meta};
  }
  .doc-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media print { .page { padding: 0; } }
`;
