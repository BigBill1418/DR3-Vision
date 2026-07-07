// ADR-0039 D4 — admin workbook-import surface (retro-audit). Admin-only per hard
// rule #2 (admin POWERS stay role=admin). Upload a historical monthly workbook;
// it is parsed server-side into staging rows + audit findings.

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { WorkbookUploadForm, type SiteOption } from './workbook-upload-form';

export const dynamic = 'force-dynamic';

export default async function WorkbookImportPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin only</h1>
        <p className="mt-2 text-gray-600">Workbook import is restricted to administrators.</p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const sites = await prisma.site.findMany({ select: { code: true, name: true }, orderBy: { name: 'asc' } });
  const siteOptions: SiteOption[] = sites.map((s) => ({ code: s.code, name: s.name }));

  const recent = await prisma.workbookImport.findMany({
    orderBy: { created_at: 'desc' },
    take: 15,
    select: {
      id: true,
      original_filename: true,
      period_label: true,
      status: true,
      template_generation: true,
      row_count: true,
      created_at: true,
      site: { select: { name: true } },
    },
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link href="/admin" className="text-sm text-emerald-700 hover:underline">
        ← Admin
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">Workbook import (retro-audit)</h1>
      <p className="mt-1 text-sm text-gray-500">
        Upload a historical monthly workbook. It is parsed server-side into staging rows (never operational
        tables); the Summary-recompute and site-alias checks run immediately and open findings on the site&apos;s
        audit queue. The original file is retained in R2 for evidence.
      </p>

      <div className="mt-6">
        <WorkbookUploadForm sites={siteOptions} />
      </div>

      <h2 className="mt-8 text-lg font-semibold text-gray-900">Recent imports</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2">Site</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Template</th>
              <th className="px-3 py-2">Rows</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                  No imports yet.
                </td>
              </tr>
            ) : (
              recent.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/admin/audit/workbook/${r.id}`} className="text-emerald-700 hover:underline">
                      {r.original_filename}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.site.name}</td>
                  <td className="px-3 py-2">{r.period_label ?? '—'}</td>
                  <td className="px-3 py-2">{r.template_generation ?? '—'}</td>
                  <td className="px-3 py-2">{r.row_count}</td>
                  <td className="px-3 py-2">{r.status}</td>
                  <td className="px-3 py-2 text-gray-500">{r.created_at.toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
