// handoff §1.8 — the manager Yard view (SCAFFOLD: list + add/edit, no workflow).
//
// Site-scoped (hard rule #2) via `checkManagerForSite`. Gated by the ADR-0047
// UI-surface rollout (`yard_list`): in pilot the surface is admin-only; a manager
// sees it only once the surface is flipped live for THEIR site. Working surface →
// green palette (ADR-0014/0008). The main table strings are i18n'd (`useT`) inside
// the client component; the static gate/denied messages render English inline here,
// matching the equipment page.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { getYardView } from '@/lib/yard/service';
import { YardClient } from './YardClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function YardPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/yard`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted to {siteCode} managers.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const isAdmin = result.ctx.role === 'admin';
  const yardLive = await isUiSurfaceLive(UI_SURFACE.YARD_LIST, result.ctx.siteId);
  if (!isAdmin && !yardLive) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Not yet activated</h1>
        <p className="mt-2 max-w-md opacity-80">
          The Yard view (handoff §1.8) is staged but not yet activated for managers at this site.
          Admin access only until it is ramped from the rollout panel (ADR-0047).
        </p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const view = await getYardView(result.ctx.siteId);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <YardClient siteCode={siteCode} siteName={result.ctx.siteName} initialView={view} />
      </div>
    </main>
  );
}
