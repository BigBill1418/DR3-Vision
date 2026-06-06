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

import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import { formatCents } from '@/lib/bonus/calculator';
import { assemblePdfRows, type PdfEntry } from '@/lib/bonus/pdf-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SignatureBlock {
  label: string;
  attestation: string;
  signedName: string | null;
  signedRole: string;
  signedAt: Date | null;
  signedIp: string | null;
  signedUserAgent: string | null;
  overrideActorName: string | null;
  overrideReason: string | null;
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

  const month = await prisma.bonusMonth.findUnique({
    where: { id: monthId },
    include: {
      site: { select: { code: true, name: true } },
      janette_signed_by: { select: { name: true } },
      morena_signed_by: { select: { name: true } },
    },
  });
  if (!month) notFound();

  // Employees + entries for this month.
  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_month_id: month.id },
    select: { bonus_employee_id: true, entry_date: true, mattress_count: true },
  });
  const employees = await prisma.bonusEmployee.findMany({
    where: { site_id: month.site_id },
    select: { id: true, full_name: true },
  });

  // Rule effective at the month's start drives the math (CLAUDE.md hard rule #3).
  const rule = await resolveActiveRule(month.site_id, month.month_start);

  const data = assemblePdfRows({
    month: {
      id: month.id,
      site_id: month.site_id,
      month_start: month.month_start,
      month_end: month.month_end,
      state: month.state,
      total_payout_cents: month.total_payout_cents,
      amended_from_month_id: month.amended_from_month_id,
    },
    site: { code: month.site.code, name: month.site.name },
    employees,
    entries: entries as PdfEntry[],
    rule,
  });

  // Resolve override-actor display names (admin signed in someone's place).
  const overrideActorIds = [month.janette_override_actor_id, month.morena_override_actor_id].filter(
    (v): v is string => typeof v === 'string',
  );
  const overrideActors = overrideActorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: overrideActorIds } },
        select: { id: true, name: true },
      })
    : [];
  const actorName = (id: string | null): string | null =>
    id ? (overrideActors.find((u) => u.id === id)?.name ?? id) : null;

  const signatures: SignatureBlock[] = [
    {
      label: 'Facility Manager',
      attestation:
        'I attest that the mattress counts and processor bonuses reported above are accurate for the month shown.',
      signedName: month.janette_signed_by?.name ?? null,
      signedRole: 'Facility Manager (Woodland)',
      signedAt: month.janette_signed_at,
      signedIp: month.janette_signed_ip,
      signedUserAgent: month.janette_signed_user_agent,
      overrideActorName: actorName(month.janette_override_actor_id),
      overrideReason: month.janette_override_reason,
    },
    {
      label: 'Operations Manager',
      attestation:
        'I attest that I have reviewed and approve the processor bonuses reported above for payroll.',
      signedName: month.morena_signed_by?.name ?? null,
      signedRole: 'Operations Manager',
      signedAt: month.morena_signed_at,
      signedIp: month.morena_signed_ip,
      signedUserAgent: month.morena_signed_user_agent,
      overrideActorName: actorName(month.morena_override_actor_id),
      overrideReason: month.morena_override_reason,
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
              <div className="brand-mark">DR3</div>
              <div className="brand-sub">Vision</div>
            </div>
            <div className="title-block">
              {/* site.name already includes the "DR3" prefix (e.g. "DR3 Woodland"). */}
              <h1>{month.site.name} — Monthly Processor Bonus Report</h1>
              <p className="subtitle">{data.monthLabel}</p>
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
              <div className="seal">SVdP</div>
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
                  Monthly Grand Total
                </td>
                <td className="col-num grand-total">{formatCents(data.grandTotalCents)}</td>
              </tr>
            </tfoot>
          </table>

          <section className="signatures">
            {signatures.map((s) => (
              <div className="sig-block" key={s.label}>
                <div className="sig-attest">{s.attestation}</div>
                <div className="sig-line">
                  <span className="sig-name">{s.signedName ?? '— not signed —'}</span>
                </div>
                <div className="sig-meta">
                  <div>{s.signedRole}</div>
                  <div>Signed: {fmtTimestamp(s.signedAt)}</div>
                  <div>IP: {s.signedIp ?? '—'}</div>
                  <div className="sig-ua">UA: {s.signedUserAgent ?? '—'}</div>
                  {s.overrideActorName && (
                    <div className="sig-override">
                      Signed on their behalf by {s.overrideActorName}
                      {s.overrideReason ? ` — ${s.overrideReason}` : ''}
                    </div>
                  )}
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

// Inline, print-friendly CSS using the DR3 brand palette. Self-contained so the
// headless render needs no external stylesheet (Tailwind isn't reliably present
// for a route that renders a full <html> document outside the app shell).
const PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #1A1A1A;
    background: #fff;
  }
  .page { padding: 32px 40px; max-width: 800px; margin: 0 auto; }
  .report-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; border-bottom: 3px solid #00524C; padding-bottom: 16px;
  }
  .brand { text-align: center; min-width: 96px; }
  .brand-mark {
    font-size: 28px; font-weight: 800; color: #00524C; letter-spacing: 1px;
    background: #EFFE8B; border-radius: 8px; padding: 8px 10px; display: inline-block;
  }
  .seal {
    font-size: 22px; font-weight: 800; color: #fff; background: #0B6662;
    border-radius: 50%; width: 56px; height: 56px; line-height: 56px;
    display: inline-block; text-align: center;
  }
  .brand-sub { font-size: 11px; color: #0B6662; margin-top: 4px; }
  .title-block { flex: 1; text-align: center; }
  .title-block h1 { font-size: 20px; margin: 0 0 4px; color: #00524C; }
  .subtitle { font-size: 14px; margin: 0; color: #1A1A1A; }
  .amended-marker {
    margin: 8px 0 2px; font-size: 16px; font-weight: 800; letter-spacing: 2px;
    color: #b91c1c;
  }
  .amended-note { margin: 0; font-size: 11px; color: #444; font-style: italic; }
  .bonus-table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  .bonus-table th, .bonus-table td {
    border-bottom: 1px solid #d8e0dc; padding: 8px 10px; font-size: 13px;
  }
  .bonus-table thead th {
    background: #00524C; color: #FCFFD7; text-align: left; border-bottom: none;
  }
  .col-num { text-align: right; }
  th.col-num { text-align: right; }
  .bonus-table tfoot td {
    border-top: 2px solid #00524C; border-bottom: none; font-weight: 700;
    padding-top: 10px;
  }
  .grand-label { text-align: right; }
  .grand-total { color: #00524C; }
  .signatures { display: flex; gap: 32px; margin-top: 40px; }
  .sig-block { flex: 1; }
  .sig-attest { font-size: 11px; color: #333; min-height: 32px; }
  .sig-line { border-bottom: 1px solid #1A1A1A; margin: 28px 0 6px; padding-bottom: 4px; }
  .sig-name { font-size: 15px; font-weight: 600; }
  .sig-meta { font-size: 10px; color: #555; line-height: 1.5; }
  .sig-ua { word-break: break-all; }
  .sig-override { margin-top: 4px; color: #00524C; font-weight: 600; }
  .report-foot {
    display: flex; justify-content: space-between; margin-top: 48px;
    padding-top: 12px; border-top: 1px solid #d8e0dc; font-size: 10px; color: #777;
  }
  .doc-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media print { .page { padding: 0; } }
`;
