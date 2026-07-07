// ADR-0048 D5 — workbook-import detail + promotion surface. Admin-only per hard
// rule #2 (admin POWERS stay role=admin). Shows the import summary and, on it, the
// staging→operational promotion panel: allowed scope options, a read-only dry-run
// preview (counts per table + conflicts + recomputed close vs the known figure),
// then commit.

import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { allowedScopesForSite } from '@/lib/audit/backfill-scopes';
import { PromotionPanel } from './promotion-panel';

export const dynamic = 'force-dynamic';

export default async function WorkbookImportDetailPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin only</h1>
        <p className="mt-2 text-gray-600">Workbook promotion is restricted to administrators.</p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const { importId } = await params;
  const imp = await prisma.workbookImport.findUnique({
    where: { id: importId },
    select: {
      id: true,
      original_filename: true,
      period_label: true,
      status: true,
      template_generation: true,
      row_count: true,
      created_at: true,
      site: { select: { name: true, code: true } },
    },
  });
  if (!imp) notFound();

  const promotion = await prisma.workbookPromotion.findUnique({
    where: { import_id: importId },
    select: { id: true, promoted_at: true, counts: true, computed_close_total: true, scope: true },
  });

  const scopes = allowedScopesForSite(imp.site.code);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link href="/admin/audit/workbook" className="text-sm text-emerald-700 hover:underline">
        ← Workbook imports
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">Workbook import</h1>

      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm sm:grid-cols-3">
        <Field label="File" value={imp.original_filename} mono />
        <Field label="Site" value={imp.site.name} />
        <Field label="Period" value={imp.period_label ?? '—'} />
        <Field label="Template" value={imp.template_generation ?? '—'} />
        <Field label="Staging rows" value={String(imp.row_count)} />
        <Field label="Status" value={imp.status} />
      </dl>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Promote to operational tables</h2>
        <p className="mt-1 text-sm text-gray-500">
          One-shot, idempotent, audited (ADR-0048). Promoted rows carry <code>source=import</code> and this
          import&apos;s id. Always dry-run first: it previews the per-table counts, any conflicting live rows, and the
          recomputed June-close balance. Promotion refuses on any conflict, and refuses to commit unless the close
          matches the known figure.
        </p>

        {promotion ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-medium">Already promoted.</p>
            <p className="mt-1">
              Promoted {promotion.promoted_at.toLocaleString()} · recomputed close{' '}
              <strong>{promotion.computed_close_total?.toString() ?? '—'}</strong>. Re-running is a no-op.
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-white/70 p-2 text-xs">
              {JSON.stringify(promotion.counts, null, 2)}
            </pre>
          </div>
        ) : scopes.length === 0 ? (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            No backfill scope is configured for site <strong>{imp.site.code}</strong>. Add one to
            <code className="mx-1">src/lib/audit/backfill-scopes.ts</code> before promoting.
          </p>
        ) : (
          <PromotionPanel importId={imp.id} scopes={scopes} />
        )}
      </section>
    </main>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`mt-0.5 text-gray-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
