// ADR-0063 — admin equipment master: edit page.
//
// `/admin/equipment/new` and `/admin/equipment/import` are STATIC segments and
// Next resolves them ahead of this dynamic one, so neither is ever mistaken
// for an equipment id.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { getEquipment } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { EquipmentEditForm } from './EquipmentEditForm';
import { CATEGORY_LABEL } from '../labels';
import {
  buildEquipmentListHref,
  pickEquipmentListParams,
  type EquipmentListSearchParams,
} from '../list-url';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<EquipmentListSearchParams>;
}

export default async function EditEquipmentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect(`/login?next=/admin/equipment/${id}`);
    redirect('/admin/equipment');
  }

  const [sites, equipment] = await Promise.all([
    prisma.site.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
    getEquipment(id),
  ]);
  if (!equipment) notFound();

  // Return the admin to the filtered list they came from, not the bare one.
  const view = pickEquipmentListParams(await searchParams);
  const backHref = buildEquipmentListHref({
    ...view,
    site: view.site && sites.some((s) => s.code === view.site) ? view.site : undefined,
  });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={backHref}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.equipment.pageTitle}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.equipment.editHeading}</h1>
          <p className="text-sm text-dr3-mist-dim">
            {equipment.display_name} ({CATEGORY_LABEL[equipment.category]})
          </p>
        </header>
        {/* ADR-0077 D6 — the asset master says WHAT this is; the machine ledger
            says what it has COST. Linked only for a machine that actually has a
            ledger worth opening (category `terex`, live, with a resolvable site
            code) so the link never lands on an empty page. */}
        {equipment.category === 'terex' && equipment.site_code && !equipment.merged_into_id ? (
          <Link
            href={`/dashboard/${equipment.site_code}/equipment/${equipment.id}`}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            View machine ledger — maintenance log, AP spend and downtime →
          </Link>
        ) : null}
        <EquipmentEditForm equipment={equipment} sites={sites} backHref={backHref} />
      </div>
    </main>
  );
}
