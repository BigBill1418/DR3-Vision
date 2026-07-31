// ADR-0067 §3.4 — /admin/doc-ingest: the sources list + the confirm queue.
//
// Admin-only, and that is load-bearing rather than conventional: this list shows
// sources whose `site_id` is NULL. A NULL site means UNCLASSIFIED, never "both"
// (hard rule #2), so it must not appear in any site-scoped surface. An admin-only
// view that shows everything is the only honest home for a document nobody has
// scoped yet.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import { listDocSources } from '@/lib/doc-ingest/health';
import { SourcesClient } from './SourcesClient';
import { RegisterShareClient } from './RegisterShareClient';

export const dynamic = 'force-dynamic';

export default async function DocIngestSourcesPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/doc-ingest');
    redirect('/admin');
  }

  const [sources, sites] = await Promise.all([
    listDocSources(prisma),
    prisma.site.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {AM.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.sources.title}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.sources.subtitle}</p>
          <nav className="mt-2 flex gap-4 text-sm">
            <Link href="/admin/doc-ingest/anomalies" className="text-dr3-cyan hover:underline">
              {M.anomalies.title}
            </Link>
            <Link href="/admin/doc-ingest/health" className="text-dr3-cyan hover:underline">
              {M.health.title}
            </Link>
            <Link href="/admin/doc-ingest/reconciliation" className="text-dr3-cyan hover:underline">
              {M.reconciliation.title}
            </Link>
            <Link href="/admin/doc-ingest/trailers" className="text-dr3-cyan hover:underline">
              {M.trailers.title}
            </Link>
            <Link href="/admin/doc-ingest/connect" className="text-dr3-cyan hover:underline">
              {M.pageTitle}
            </Link>
          </nav>
        </header>
        <RegisterShareClient />
        <SourcesClient initialSources={sources} sites={sites} />
      </div>
    </main>
  );
}
