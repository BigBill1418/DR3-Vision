// T-014 — audit-log -> load-detail resolver.
//
// The audit log records `(table_name, row_id)` in a site-agnostic
// shape, but the manager load-detail page lives at
// `/dashboard/[site]/load/[id]`. This resolver looks the row up,
// derives its site, and redirects. Admin-gated; if the row was
// hard-deleted (rare; loads aren't soft-deletable today) we fall back
// to the audit list with a notice. We do NOT 404 — that would be a
// poor UX for an admin tracing a row's history.

import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AuditLoadResolverPage({ params }: Props) {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/audit');
    redirect('/admin/audit');
  }

  const { id } = await params;
  if (!id || id.length === 0) notFound();

  const load = await prisma.inboundLoad.findUnique({
    where: { id },
    select: { id: true, site: { select: { code: true } } },
  });

  if (!load || !load.site) {
    // Row gone (hard-delete) — bounce back to the audit list rather
    // than rendering a 404 inside the admin panel. The list cell
    // already labels missing rows; this resolver is reachable only
    // from outdated audit links (e.g., browser history).
    redirect('/admin/audit');
  }

  redirect(`/dashboard/${load.site.code}/load/${load.id}`);
}
