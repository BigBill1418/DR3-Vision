import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { LoadWorkflow } from './load-workflow';
import { HOME_ROUTE } from '@/lib/routes';

// Workflow shell. The whole 7-stage flow lives in the
// `LoadWorkflow` client component and dispatches by `load.status`.
// Server-side this page just hydrates the load + the operator's
// session, then hands off.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; id: string }> };

export default async function LoadPage({ params }: Props) {
  const { site: siteCode, id: loadId } = await params;
  const session = await auth();
  if (!session?.user) redirect(`/operator/${siteCode}`);
  if (session.user.role !== 'operator') redirect(HOME_ROUTE);

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();
  if (session.user.primary_site_id !== site.id) redirect('/operator');

  const load = await prisma.inboundLoad.findUnique({
    where: { id: loadId },
    select: {
      id: true,
      site_id: true,
      status: true,
      bol_number: true,
      arrived_at: true,
      unload_started_at: true,
      unload_finished_at: true,
      total_units: true,
      assigned_operator_id: true,
      source: { select: { name: true } },
      transporter: { select: { name: true } },
      load_stacks: {
        select: { id: true, stack_index: true, unit_count: true, count_mode: true },
        orderBy: { stack_index: 'asc' },
      },
    },
  });
  if (!load || load.site_id !== site.id) notFound();
  if (load.assigned_operator_id !== session.user.id) {
    // Another operator owns this load. T-010 portal lets a manager
    // reassign it; from the iPad we just bounce back to the queue.
    redirect(`/operator/${siteCode}/queue`);
  }

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string) => translate(dict, k);

  return (
    <main className="px-6 pb-6">
      <div className="mx-auto max-w-2xl pt-6">
        <header className="mb-4">
          <h1 className="text-xl font-semibold">
            {load.source?.name ?? t('load_header.unknown_source')}
          </h1>
          <p className="text-sm text-dr3-cream/70">
            {load.transporter?.name ?? t('load_header.unknown_carrier')} ·{' '}
            {t('load_header.bol_label')}{' '}
            <span className="font-mono">{load.bol_number ?? t('load_header.bol_dash')}</span>
          </p>
        </header>
        <LoadWorkflow
          siteCode={site.code}
          load={{
            id: load.id,
            status: load.status,
            unload_started_at: load.unload_started_at?.toISOString() ?? null,
            total_units: load.total_units,
            stacks: load.load_stacks,
          }}
          operatorName={session.user.name}
        />
      </div>
    </main>
  );
}
