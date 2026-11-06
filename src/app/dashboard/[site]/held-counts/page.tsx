// ADR-0072 Amendment 1 — the manager's held-count screen.
//
// Tier 2 counts are held until a manager releases or discards them. ADR-0072
// shipped the remote release route (`/api/manager/<site>/count-holds/<id>`) but
// no screen called it, and the only other path — a manager PIN on the iPad —
// cannot work for anyone without a floor PIN, which on 2026-11-06 was every
// manager and admin. Woodland had 4 holds pending and none had ever been
// approved. This is the screen the route was built for.
//
// Gated exactly like the route behind it: `checkManagerForSite`, nothing more.
// A rollout gate here that the route does not have would hide the only working
// approval path behind a switch, which is how the holds piled up in the first
// place. Every read is bound to this site's id (CLAUDE.md hard rule #2).
//
// Names are resolved here, not in the inventory services (ADR-0084 Am.1).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { loadPriorAnchor } from '@/lib/inventory/anchor-guardrail';
import { isLargeSwing, sameCountPending } from '@/lib/inventory/held-count-review';
import { prisma } from '@/lib/prisma';
import { HeldCountsClient, type HeldCountView } from './HeldCountsClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function HeldCountsPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/held-counts`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 max-w-md opacity-80">This area is restricted.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }
  const { ctx } = result;

  const [holds, onRecord] = await Promise.all([
    prisma.inventoryCountHold.findMany({
      where: { site_id: ctx.siteId, status: 'pending' },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        created_at: true,
        created_by: true,
        counted_by: true,
        confirmed_by: true,
        prior_total: true,
        new_total: true,
        swing_pct: true,
        threshold_pct: true,
      },
    }),
    loadPriorAnchor(prisma, ctx.siteId),
  ]);

  const ids = [...new Set(holds.map((h) => h.created_by))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const lookalikes = sameCountPending(
    holds.map((h) => ({ id: h.id, createdAt: h.created_at, newTotal: h.new_total })),
  );

  // The last physical count's own total (the anchor), not a running-balance pool.
  const onRecordLabel = onRecord ? onRecord.total.toLocaleString('en-US') : 'no count yet'; // onhand-presenter-ok: a physical count's own total, never a pool
  const view: HeldCountView[] = holds.map((h) => {
    const swingPct = Number(h.swing_pct);
    const thresholdPct = Number(h.threshold_pct);
    return {
      id: h.id,
      createdAtISO: h.created_at.toISOString(),
      // An id that resolves to nothing stays null and renders "not recorded" —
      // never a placeholder name against an action the person did not take.
      enteredByName: nameOf.get(h.created_by) ?? null,
      countedBy: h.counted_by,
      confirmedBy: h.confirmed_by,
      enteredByMe: h.created_by === ctx.userId,
      priorTotal: h.prior_total,
      newTotal: h.new_total,
      swingPct,
      thresholdPct,
      largeSwing: isLargeSwing(swingPct, thresholdPct),
      sameCountPending: lookalikes.get(h.id) ?? 1,
    };
  });

  return (
    <main className="min-h-screen bg-dr3-space px-4 py-8 text-dr3-mist sm:px-6">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Held counts — {ctx.siteName}</h1>
        <p className="mt-2 max-w-3xl text-sm opacity-80">
          Physical counts entered on the floor that moved the inventory by more than this
          site&apos;s threshold. <strong>Nothing has been written to inventory yet.</strong>{' '}
          Approving one makes it the count the floor and the COR are computed from; discarding one
          writes nothing and records your reason. You cannot approve a count you entered yourself.
        </p>
        <p className="mt-2 text-sm opacity-80" data-testid="on-record">
          On record now: <strong>{onRecordLabel}</strong>
          {onRecord && ' units (the most recent physical count). Approval re-checks against this.'}
        </p>
        <HeldCountsClient siteCode={siteCode} holds={view} />
      </div>
    </main>
  );
}
