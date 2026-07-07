// ADR-0048 D3 — Terex equipment-history import surface. Admin-only per hard rule
// #2. Upload Janette's Terex spreadsheet (xlsx/csv); rows land in equipment_events
// with source='import'. The importer uses a flexible header-detection mapping and
// is finalized against the real file on receipt (banner below).

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { TerexUploadForm, type SiteOption } from './terex-upload-form';

export const dynamic = 'force-dynamic';

export default async function TerexImportPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin only</h1>
        <p className="mt-2 text-gray-600">Equipment history import is restricted to administrators.</p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const sites = await prisma.site.findMany({ select: { code: true, name: true }, orderBy: { name: 'asc' } });
  const siteOptions: SiteOption[] = sites.map((s) => ({ code: s.code, name: s.name }));

  const recent = await prisma.equipmentHistoryImport.findMany({
    orderBy: { imported_at: 'desc' },
    take: 15,
    select: {
      id: true,
      original_filename: true,
      rows_parsed: true,
      events_created: true,
      events_skipped: true,
      imported_at: true,
    },
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link href="/admin" className="text-sm text-emerald-700 hover:underline">
        ← Admin
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">Terex history import</h1>

      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Provisional mapping — finalized against the real file on receipt.</p>
        <p className="mt-1">
          Until Janette&apos;s Terex spreadsheet is in hand, this importer uses flexible header detection
          (date / notes / hours / downtime columns). It <strong>fails loudly</strong> on an unrecognized shape — it
          never guesses rows. A downtime entry becomes a downtime event (with hours where stated); every other row
          becomes a note. Re-uploading the identical file is a no-op.
        </p>
      </div>

      <div className="mt-6">
        <TerexUploadForm sites={siteOptions} />
      </div>

      <h2 className="mt-8 text-lg font-semibold text-gray-900">Recent imports</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2">Rows</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Skipped</th>
              <th className="px-3 py-2">Imported</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                  No imports yet.
                </td>
              </tr>
            ) : (
              recent.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono text-xs text-gray-800">{r.original_filename}</td>
                  <td className="px-3 py-2 tabular-nums">{r.rows_parsed}</td>
                  <td className="px-3 py-2 tabular-nums">{r.events_created}</td>
                  <td className="px-3 py-2 tabular-nums">{r.events_skipped}</td>
                  <td className="px-3 py-2 text-gray-500">{r.imported_at.toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
