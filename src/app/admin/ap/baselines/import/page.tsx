// ADR-0046 Amendment 5 (D-M5-4) — baseline import surface (admin-only).
//
// Bill drops a GP AP-history PDF into /admin/file-drop; the admin picks it here,
// previews the parsed rows (no write), then confirms — writing bill_upload history
// and rebuilding baselines. Admin-only per hard rule #2. The parse is best-effort:
// the preview is the human guard, so the admin reviews every row before confirm.

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { BaselineImportClient, type FileDropOption } from './BaselineImportClient';

export const dynamic = 'force-dynamic';

export default async function BaselineImportPage() {
  const session = await auth();
  if (!session?.user) redirect('/login?next=/admin/ap/baselines/import');
  if (session.user.role !== 'admin') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin only</h1>
        <p className="mt-2 text-gray-600">Baseline import is restricted to administrators.</p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // Show recent PDF-ish file-drops the admin might import (raw inbox is content-typed).
  const drops = await prisma.fileDrop.findMany({
    orderBy: { created_at: 'desc' },
    take: 40,
    select: {
      id: true,
      original_filename: true,
      content_type: true,
      byte_size: true,
      r2_key: true,
      created_at: true,
    },
  });
  const options: FileDropOption[] = drops
    .filter(
      (d) =>
        /pdf/i.test(d.content_type) || /\.pdf$/i.test(d.original_filename),
    )
    .map((d) => ({
      id: d.id,
      filename: d.original_filename,
      byteSize: d.byte_size,
      createdISO: d.created_at.toISOString(),
      downloadable: !d.r2_key.startsWith('pending-r2-'),
    }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <Link href="/admin/ap/baselines" className="text-sm text-emerald-700 hover:underline">
        ← Vendor baselines
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">Import AP report</h1>
      <p className="mt-2 max-w-3xl text-sm text-gray-600">
        Pick a Bill-uploaded AP-report PDF (from{' '}
        <Link href="/admin/file-drop" className="text-emerald-700 hover:underline">
          file-drop
        </Link>
        ), preview the parsed invoice rows, then confirm. Confirming appends the rows to vendor
        history and rebuilds baselines. Review the rows first — the parse is best-effort.
      </p>

      <div className="mt-6">
        <BaselineImportClient fileDrops={options} />
      </div>
    </main>
  );
}
