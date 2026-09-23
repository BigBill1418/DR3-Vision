// ADR-0063 — admin equipment master: edit page.
//
// `/admin/equipment/new` and `/admin/equipment/import` are STATIC segments and
// Next resolves them ahead of this dynamic one, so neither is ever mistaken
// for an equipment id.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { equipmentReferenceCounts, getEquipment, listEquipment } from '@/lib/admin-equipment';
import { adminMessages as M } from '@/app/admin/messages';
import { EquipmentEditForm } from './EquipmentEditForm';
import { CATEGORY_LABEL } from '../labels';
import {
  FLEET_SITE_CODE,
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

  const [sites, equipment, designation] = await Promise.all([
    prisma.site.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
    getEquipment(id),
    // BX-12 (ADR-0137) — is this row a site's DESIGNATED throughput machine?
    prisma.siteThroughputMachine.findUnique({
      where: { equipment_id: id },
      select: { site_id: true },
    }),
  ]);
  if (!equipment) notFound();

  // ADR-0135 F — the merge section offers EVERY live asset in the fleet (both
  // yards, fleet-wide, active or not; merged rows excluded by `listEquipment`),
  // and previews every table the merge would repoint.
  const merge = equipment.merged_into_id
    ? null
    : await Promise.all([listEquipment({ status: 'all' }), equipmentReferenceCounts(id)]);
  const mergeCandidates = merge?.[0].filter((e) => e.id !== id);
  const referenceCounts = merge?.[1];

  // Return the admin to the filtered list they came from, not the bare one.
  const view = pickEquipmentListParams(await searchParams);
  const backHref = buildEquipmentListHref({
    ...view,
    site:
      view.site === FLEET_SITE_CODE || sites.some((s) => s.code === view.site)
        ? view.site
        : undefined,
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
            says what it has COST. Linked only for a site's DESIGNATED throughput
            machine (BX-12, ADR-0137). `category: 'terex'` is also the seed's
            category for the shear machines, and "has an invoice link" stopped
            separating them the day EQ24 was invoiced (2026-09-02). The ledger
            re-checks the same designation. */}
        {designation &&
        designation.site_id === equipment.site_id &&
        equipment.site_code &&
        !equipment.merged_into_id ? (
          <Link
            href={`/dashboard/${equipment.site_code}/equipment/${equipment.id}`}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            View the {equipment.display_name} ledger — maintenance log, AP spend and downtime →
          </Link>
        ) : null}
        <EquipmentEditForm
          equipment={equipment}
          sites={sites}
          backHref={backHref}
          mergeCandidates={mergeCandidates}
          referenceCounts={referenceCounts}
        />
      </div>
    </main>
  );
}
