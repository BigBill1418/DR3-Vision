// ADR-0039 D3 — on-demand audit run (the "run this window now" review action).
//
// Site-scoped per CLAUDE.md hard rule #2: a manager may run the audit only for a
// site they can reach (their primary site, or any site for admin / all_sites).
// Runs the same engine as the nightly sweep over an operator-chosen window and
// persists the finding lifecycle + an `audit_runs` ledger row (trigger =
// on_demand). A live sweep window omits `asOfISO` only for purely historical
// windows; an on-demand run over a window ending today keeps grace suppression
// by anchoring asOf at today.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { auditSiteWindow } from '@/lib/audit/sweep';
import { buildRunChecksForWindow } from '@/lib/audit/leg-fetchers';
import { appTodayISO } from '@/lib/time';
import type { AuditWindow } from '@/lib/audit/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string }> },
): Promise<Response> {
  const { site: siteCode } = await params;

  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true, code: true } });
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  // ADR-0116 — ROLE first, then reach. This is the order `requireManagerForSite`
  // uses (`auth-helpers.ts:50-53`) and the order CLAUDE.md hard rule #2 requires:
  // site REACH and manager POWER are two different questions and must not be
  // reconflated. This route asked only the reach question, and an operator
  // answers it: a PIN session carries a real `role` and `primary_site_id`
  // (`auth.ts:236-240`) and `middleware.ts` gates on authentication only, never
  // role — so an operator satisfied `canReach` for their own site and could POST
  // an on-demand audit run, persisting finding-lifecycle and `audit_runs` rows.
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const isAdmin = role === 'admin';
  const canReach = isAdmin || session.user.all_sites === true || session.user.primary_site_id === site.id;
  if (!canReach) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { windowStart?: string; windowEnd?: string } | null;
  const todayISO = appTodayISO();
  const windowStart = body?.windowStart;
  const windowEnd = body?.windowEnd;
  if (windowStart !== undefined && !ISO_DAY.test(windowStart)) {
    return NextResponse.json({ error: 'windowStart must be YYYY-MM-DD' }, { status: 400 });
  }
  if (windowEnd !== undefined && !ISO_DAY.test(windowEnd)) {
    return NextResponse.json({ error: 'windowEnd must be YYYY-MM-DD' }, { status: 400 });
  }
  const endISO = windowEnd ?? todayISO;
  const startISO = windowStart ?? shiftDaysISO(endISO, -14);
  if (startISO >= endISO) {
    return NextResponse.json({ error: 'windowStart must be before windowEnd' }, { status: 400 });
  }

  // asOf is today only when the window reaches today (grace clocks still tick);
  // a purely historical window elapses every clock (no grace suppression).
  const window: AuditWindow = {
    siteId: site.id,
    startISO,
    endISO,
    ...(endISO >= todayISO ? { asOfISO: todayISO } : {}),
  };

  const result = await auditSiteWindow({
    db: prisma,
    site,
    window,
    trigger: 'on_demand',
    runChecks: buildRunChecksForWindow(prisma),
  });

  if (result.status === 'error') {
    return NextResponse.json({ error: 'audit run failed', detail: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...result });
}

function shiftDaysISO(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}
