// ADR-0077 D6 — the Terex machine detail view.
//
// A DETAIL VIEW UNDER the ADR-0044 tile, reached from it — not a parallel tile.
// The tile at `/dashboard/[site]/equipment` stays generic (it is the site's
// equipment surface, and a second machine would join it tomorrow); this page is
// where one machine's whole story lives.
//
// Ships DARK: born `pilot`, so only admins reach it until Bill flips
// `equipment_terex_ledger` at /admin/rollout (OPEN-ITEMS O-12 first).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkEquipmentLedgerAccess, ledgerReaches } from '@/lib/auth-helpers';
import { computeTerexLedger } from '@/lib/equipment/terex-ledger';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { prisma } from '@/lib/prisma';
import { TerexLedgerClient } from './TerexLedgerClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; equipmentId: string }> };

function Denied({ siteCode, title, body }: { siteCode: string; title: string; body: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md opacity-80">{body}</p>
      <Link href={`/dashboard/${siteCode}/equipment`} className="mt-6 text-sm underline">
        Back to equipment
      </Link>
    </main>
  );
}

export default async function TerexLedgerPage({ params }: Props) {
  const { site: siteCode, equipmentId } = await params;

  const access = await checkEquipmentLedgerAccess();
  if (!access.ok) {
    if (access.status === 401) {
      redirect(`/login?next=/dashboard/${siteCode}/equipment/${equipmentId}`);
    }
    return (
      <Denied
        siteCode={siteCode}
        title="Access denied"
        body="This machine ledger is limited to admins and the site managers who resolve equipment requests."
      />
    );
  }

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, name: true },
  });
  if (!site || !ledgerReaches(access.ctx, site.id)) {
    return (
      <Denied
        siteCode={siteCode}
        title="Access denied"
        body="This machine belongs to a site you do not have reach for."
      />
    );
  }

  // ADR-0047 gate. Pilot ⇒ admin-only; the surface is dark until Bill flips it.
  const live = await isUiSurfaceLive(UI_SURFACE.EQUIPMENT_TEREX_LEDGER, site.id);
  if (!access.ctx.isAdmin && !live) {
    return (
      <Denied
        siteCode={siteCode}
        title="Not yet activated"
        body="The machine ledger (ADR-0077) is staged but not yet activated for managers at this site. Admin access only until it is ramped from the rollout panel (ADR-0047)."
      />
    );
  }

  const ledger = await computeTerexLedger(site.id, equipmentId, { isAdmin: access.ctx.isAdmin });
  if (!ledger.equipment) {
    return (
      <Denied
        siteCode={siteCode}
        title="No such machine"
        body="That asset does not exist at this site, or it was merged into another record."
      />
    );
  }

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}/equipment`} className="text-sm underline opacity-90">
          ← Back to equipment
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{ledger.equipment.displayName}</h1>
        <p className="mt-1 text-sm opacity-70">
          {site.name} · one machine: its maintenance log, every invoice tagged to it, and its
          recorded downtime. Nothing on this page is entered here — it reads the absorbed workbook,
          the AP decisions and the equipment event log.
        </p>
        <TerexLedgerClient ledger={ledger} siteCode={siteCode} />
      </div>
    </main>
  );
}
