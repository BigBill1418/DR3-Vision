// ADR-0037 Phase 3 (§3.3 Option B) — manager daily-close ENTRY surface.
//
// Mirrors /admin/processed-units for ENTRY and AMENDMENT only. Managers enter their
// site's daily close; BILL closes and locks it at /admin/processed-units. This page
// deliberately has no close control, and there is no manager close API to call.
//
// Gated exactly like /dashboard/<site>/loads-inventory: site-scoped manager access
// plus the ADR-0047 `loads_inventory` rollout surface (admins always pass).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { ProcessedUnitsEntryClient } from './ProcessedUnitsEntryClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

function Denied({ siteCode, title, body }: { siteCode: string; title: string; body: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md opacity-80">{body}</p>
      <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
        Back to dashboard
      </Link>
    </main>
  );
}

export default async function ProcessedUnitsClosePage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/processed-units-close`);
    return <Denied siteCode={siteCode} title="Access denied" body="This area is restricted." />;
  }

  const live = await isUiSurfaceLive(UI_SURFACE.LOADS_INVENTORY, result.ctx.siteId);
  if (result.ctx.role !== 'admin' && !live) {
    return (
      <Denied
        siteCode={siteCode}
        title="Not yet activated"
        body="The loads & inventory surfaces (ADR-0037) are not yet activated for this site. Admin access only until an admin flips the loads_inventory rollout surface live."
      />
    );
  }

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Daily close entry — {result.ctx.siteName}
        </h1>
        <p className="mt-2 max-w-3xl text-sm opacity-80">
          Enter the day&apos;s stripped units, split program vs. non-program. This is the number MRC
          is billed from, so it stays a two-step record: <strong>you enter and amend it here</strong>
          , and <strong>Bill reviews, closes and locks it</strong>. Amend a day as many times as you
          need up until it is closed — after close, edits are blocked and corrections follow the
          amendment path.
        </p>
        <ProcessedUnitsEntryClient siteCode={siteCode} />
      </div>
    </main>
  );
}
