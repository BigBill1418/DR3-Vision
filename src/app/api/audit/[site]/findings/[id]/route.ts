// ADR-0039 — manual finding-transition endpoint (review surface actions).
//
// Site-scoped per CLAUDE.md hard rule #2: a manager may only act on findings for
// a site they can reach (their primary site, or any site for admin / all_sites).
// Every transition is audited in the same transaction (see transitionFinding).

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { transitionFinding, type CauseCategory, type FindingStatus } from '@/lib/audit/lifecycle';
import { getFinding } from '@/lib/audit/findings-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: FindingStatus[] = ['open', 'acknowledged', 'resolved', 'not_an_issue'];
const CAUSES: CauseCategory[] = ['data_entry', 'operational', 'external_mymrc', 'template_defect', 'unknown'];

async function resolveSiteAccess(
  siteCode: string,
): Promise<{ status: number } | { siteId: string; userId: string }> {
  const session = await auth();
  if (!session?.user?.id) return { status: 401 };
  const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } });
  if (!site) return { status: 404 };
  // ADR-0116 — ROLE first, then reach (see the sibling `run/route.ts`). Without
  // the role gate an operator could PATCH a finding's lifecycle
  // (open → resolved / not_an_issue), which is a manager review action.
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') return { status: 403 };
  const isAdmin = role === 'admin';
  const canReach = isAdmin || session.user.all_sites === true || session.user.primary_site_id === site.id;
  if (!canReach) return { status: 403 };
  return { siteId: site.id, userId: session.user.id };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
): Promise<Response> {
  const { site: siteCode, id } = await params;
  const access = await resolveSiteAccess(siteCode);
  if ('status' in access) return NextResponse.json({ error: 'denied' }, { status: access.status });
  const finding = await getFinding(access.siteId, id);
  if (!finding) return NextResponse.json({ error: 'finding not found' }, { status: 404 });
  return NextResponse.json({ finding });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
): Promise<Response> {
  const { site: siteCode, id } = await params;

  const access = await resolveSiteAccess(siteCode);
  if ('status' in access) return NextResponse.json({ error: 'denied' }, { status: access.status });

  // The finding must belong to this site (defense-in-depth against id spoofing).
  const owned = await prisma.auditFinding.findFirst({ where: { id, site_id: access.siteId }, select: { id: true } });
  if (!owned) return NextResponse.json({ error: 'finding not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | { toStatus?: string; causeCategory?: string; resolutionNote?: string }
    | null;
  const toStatus = body?.toStatus;
  if (!toStatus || !STATUSES.includes(toStatus as FindingStatus)) {
    return NextResponse.json({ error: 'invalid toStatus' }, { status: 400 });
  }
  const causeCategory = body?.causeCategory;
  if (causeCategory !== undefined && !CAUSES.includes(causeCategory as CauseCategory)) {
    return NextResponse.json({ error: 'invalid causeCategory' }, { status: 400 });
  }

  const result = await transitionFinding({
    db: prisma,
    findingId: id,
    toStatus: toStatus as FindingStatus,
    actorUserId: access.userId,
    ...(causeCategory ? { causeCategory: causeCategory as CauseCategory } : {}),
    ...(typeof body?.resolutionNote === 'string' ? { resolutionNote: body.resolutionNote } : {}),
  });

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'cause_required' ? 422 : 409;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true });
}
