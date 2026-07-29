// ADR-0046 Amendment 9 (§2.5) — resolve / reject one AP equipment request.
//
// POST /api/admin/ap/equipment-requests/[id]  { action: 'resolve' | 'reject', … }
//
// Gated by `requireEquipmentRequestAccess()` — admin OR a site manager holding
// `can_resolve_equipment_requests` (see the long note on that guard for why this
// `/admin/*` route is deliberately not admin-only). The PAGE gate covers the UI
// surface and NOTHING ELSE: this handler re-checks independently, and re-checks
// SITE REACH against the request's own site so a single-site manager cannot
// resolve the other site's queue by posting an id (hard rule #2).
//
// Both actions are bookkeeping. NEITHER touches the invoice's approved decision.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEquipmentRequestAccess } from '@/lib/auth-helpers';
import { EQUIPMENT_CATEGORIES } from '@/app/admin/constants';
import {
  ApEquipmentRequestError,
  rejectEquipmentRequest,
  resolveEquipmentRequest,
} from '@/lib/ap/equipment-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  action?: string;
  displayName?: string;
  category?: string;
  siteId?: string;
  backfillLink?: boolean;
  note?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireEquipmentRequestAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;

  // Site reach, re-derived from the ROW — never from the payload. A single-site
  // manager who is handed (or guesses) an id from the other site gets a 403 here
  // even though the page never showed them the row.
  const row = await prisma.apEquipmentRequest.findUnique({
    where: { id },
    select: { site_id: true },
  });
  if (!row) return NextResponse.json({ error: 'Equipment request not found.' }, { status: 404 });
  if (!ctx.allSites && ctx.primarySiteId !== row.site_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const actor = {
    actorUserId: ctx.userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  };

  try {
    if (body.action === 'reject') {
      await rejectEquipmentRequest(prisma, id, body.note ?? '', actor);
      return NextResponse.json({ ok: true, status: 'rejected' });
    }
    if (body.action === 'resolve') {
      const category = EQUIPMENT_CATEGORIES.find((c) => c === body.category);
      if (!category) {
        return NextResponse.json({ error: 'Choose a category for the asset.' }, { status: 400 });
      }
      // A resolving manager may register the asset to a different site than the
      // invoice was filed against (a machine that lives at the other yard), but
      // only within their own reach.
      const siteId = typeof body.siteId === 'string' && body.siteId ? body.siteId : row.site_id;
      if (!ctx.allSites && ctx.primarySiteId !== siteId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
      const result = await resolveEquipmentRequest(
        prisma,
        id,
        {
          displayName: body.displayName ?? '',
          category,
          siteId,
          ...(typeof body.backfillLink === 'boolean' ? { backfillLink: body.backfillLink } : {}),
          ...(body.note ? { note: body.note } : {}),
        },
        actor,
      );
      return NextResponse.json({ ok: true, status: 'resolved', ...result });
    }
    return NextResponse.json({ error: "action must be 'resolve' or 'reject'" }, { status: 400 });
  } catch (e) {
    if (e instanceof ApEquipmentRequestError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    // The `(site_id, display_name)` unique is the real guard behind the data
    // layer's friendly pre-check; surface a race loss as a readable 409 rather
    // than a 500 (mirrors createEquipment's P2002 backstop).
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002') {
      return NextResponse.json(
        { error: 'An asset with that name already exists at this site.' },
        { status: 409 },
      );
    }
    throw e;
  }
}
