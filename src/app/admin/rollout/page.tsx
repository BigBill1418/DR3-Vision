// ADR-0047 — the admin rollout panel. Lists every registered surface × site with
// its pilot/live state + last-flip evidence, and lets an admin flip state (with a
// required criteria note, audited). Admin-role only (checkAdmin) per hard rule #2.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkAdmin } from '@/lib/auth-helpers';
import { adminMessages as AM } from '@/app/admin/messages';
import { prisma } from '@/lib/prisma';
import { RolloutClient, type SurfaceRow } from './RolloutClient';

export const dynamic = 'force-dynamic';

export default async function AdminRolloutPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/rollout');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{AM.forbiddenHeading}</h1>
        <p className="mt-2 text-dr3-mist-dim">{AM.forbiddenBody}</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          Back
        </Link>
      </main>
    );
  }

  const [surfaces, sites] = await Promise.all([
    prisma.rolloutSurface.findMany({
      orderBy: [{ kind: 'asc' }, { surface_code: 'asc' }, { site_id: 'asc' }],
    }),
    prisma.site.findMany({ select: { id: true, code: true } }),
  ]);
  const siteCodeById = new Map(sites.map((s) => [s.id, s.code]));
  const flipperIds = [...new Set(surfaces.map((s) => s.flipped_by).filter((x): x is string => !!x))];
  const flippers = flipperIds.length
    ? await prisma.user.findMany({ where: { id: { in: flipperIds } }, select: { id: true, name: true } })
    : [];
  const flipperName = new Map(flippers.map((u) => [u.id, u.name]));

  const rows: SurfaceRow[] = surfaces.map((s) => ({
    id: s.id,
    kind: s.kind,
    surfaceCode: s.surface_code,
    siteLabel: s.site_id ? (siteCodeById.get(s.site_id) ?? s.site_id) : 'org-wide',
    state: s.rollout_state,
    flippedByName: s.flipped_by ? (flipperName.get(s.flipped_by) ?? 'unknown') : null,
    flippedAtISO: s.flipped_at ? s.flipped_at.toISOString() : null,
    criteriaNote: s.criteria_note,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/admin"
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Staff-output rollout gate</h1>
        <p className="mt-2 max-w-3xl text-sm text-dr3-mist-dim">
          Every staff-facing surface × site (ADR-0047). <strong>Pilot</strong> = admin-only: notification
          output reroutes to admins with a &ldquo;would have sent to&rdquo; header, and gated UI surfaces
          stay admin-only — staff receive/see nothing. Flip to <strong>live</strong> to ramp a surface to
          its designed audience. A flip needs a criteria note and is audited + immediate; rollback is the
          inverse flip (no code).
        </p>
        <RolloutClient rows={rows} />
      </div>
    </main>
  );
}
