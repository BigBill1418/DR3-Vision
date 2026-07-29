// ADR-0067 §3.4 — /admin/doc-ingest/anomalies: the before/after review queue.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import { listAnomalies } from '@/lib/doc-ingest/health';
import { AnomaliesClient } from './AnomaliesClient';

export const dynamic = 'force-dynamic';

export default async function DocIngestAnomaliesPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/doc-ingest/anomalies');
    redirect('/admin');
  }

  const anomalies = await listAnomalies(prisma, false);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin/doc-ingest"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.sources.title}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.anomalies.title}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.anomalies.subtitle}</p>
          <p className="text-xs text-dr3-mist-dim">
            <Link href="/admin" className="hover:text-dr3-cyan hover:underline">
              {AM.backToDashboard}
            </Link>
          </p>
        </header>
        <AnomaliesClient initialAnomalies={anomalies} />
      </div>
    </main>
  );
}
