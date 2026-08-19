// ADR-0105 — the manager count-correction surface.
//
// Gated exactly like /dashboard/<site>/{loads-inventory,processed-units-close}:
// site-scoped manager access (hard rule #2) plus the ADR-0047 `loads_inventory`
// rollout surface, admins always passing. Deliberately the SAME gate as the API
// route behind it (`requireActivatedManager`), so a site whose loads/inventory
// module is dark has neither the screen nor a live endpoint behind it.
//
// The list is read SERVER-SIDE via `listWindowCountsAtSite`, the same function
// `GET .../correct` returns — the sibling pages call `onHand` directly the same
// way. One function, two callers, no HTTP round-trip to render the first paint.
//
// Names are resolved HERE, not in the service: ADR-0084 Amendment 1 settled that
// the inventory services stay free of a `users` dependency, and this is the same
// screen-side name resolution it introduced for the iPad void list.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { listWindowCountsAtSite } from '@/lib/inventory/correct-count';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { prisma } from '@/lib/prisma';
import { CountCorrectionsClient, type CountRowView } from './CountCorrectionsClient';

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

export default async function CountCorrectionsPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/count-corrections`);
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

  const rows = await listWindowCountsAtSite(result.ctx.siteId);

  // One lookup for every id the list mentions. An id that resolves to nothing is
  // left as null and rendered "not recorded" — never backfilled with a placeholder
  // name, which would put a person's name against an action they did not take.
  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.enteredByUserId, r.voidedByUserId]).filter((v): v is string => !!v),
    ),
  ];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const view: CountRowView[] = rows.map(({ enteredAt, ...r }) => ({
    ...r,
    enteredAtISO: enteredAt.toISOString(),
    enteredByName: r.enteredByUserId ? (nameOf.get(r.enteredByUserId) ?? null) : null,
    voidedByName: r.voidedByUserId ? (nameOf.get(r.voidedByUserId) ?? null) : null,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Count corrections — {result.ctx.siteName}
        </h1>
        <p className="mt-2 max-w-3xl text-sm opacity-80">
          The physical counts taken here <strong>today and yesterday</strong>. If one was keyed
          wrong, put the right number in and save it — the corrected value becomes the count the
          floor and the COR are computed from, and the number it replaced is{' '}
          <strong>kept and shown below it</strong>, marked superseded. Nothing is deleted and no
          approval is needed. An older count is changed from <code>/admin/inventory/anchors</code>.
        </p>
        <CountCorrectionsClient siteCode={siteCode} rows={view} />
      </div>
    </main>
  );
}
