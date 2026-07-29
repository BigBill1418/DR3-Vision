// ADR-0066 §1.4 + §1.6 — the AP configuration API.
//
// GET   /api/admin/ap/config — the whole surface (routing + prefs + warnings)
// PATCH /api/admin/ap/config — discriminated union: save a routing pair, or
//                              flip one notification event for one user
//
// ONE route for both halves, following ADR-0017's discriminated-union PATCH
// precedent: it keeps the surface narrow and gives every action the same
// role-gate + actor + IP/UA capture path.
//
// Admin-only. `/admin/*` is an admin POWER, gated on `role === 'admin'` — never
// on the `all_sites` reach flag (CLAUDE.md hard rule #2; the two must not be
// reconflated). The page layer gates as well, and the API never trusts it.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  FALLBACK_HOURS_MAX,
  FALLBACK_HOURS_MIN,
  ROUTING_STATUSES,
  getApConfig,
  saveRoutingRow,
  setNotificationPref,
  type SaveRoutingReason,
  type SetPrefReason,
} from '@/lib/ap/admin-config';
import { AP_NOTIFICATION_EVENTS } from '@/lib/ap/notification-prefs';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AC = M.apConfig;

const saveRoutingSchema = z.object({
  action: z.literal('save_routing'),
  first_approver_id: z.string().min(1),
  second_approver_id: z.string().min(1),
  fallback_approver_id: z.string().min(1).nullable(),
  fallback_after_hours: z.number().int().min(FALLBACK_HOURS_MIN).max(FALLBACK_HOURS_MAX),
  active: z.boolean(),
});

const setPrefSchema = z.object({
  action: z.literal('set_pref'),
  user_id: z.string().min(1),
  event: z.enum(AP_NOTIFICATION_EVENTS),
  value: z.boolean(),
});

const patchSchema = z.discriminatedUnion('action', [saveRoutingSchema, setPrefSchema]);

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  void ctx;

  const raw = new URL(req.url).searchParams.get('status') ?? undefined;
  const status = raw && (ROUTING_STATUSES as readonly string[]).includes(raw) ? raw : undefined;

  const config = await getApConfig(
    status ? { status: status as (typeof ROUTING_STATUSES)[number] } : {},
  );
  return NextResponse.json({ config });
}

export async function PATCH(req: Request) {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: M.errors.invalidPayload, details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const actor = {
    actorUserId: ctx.userId,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  };

  if (parsed.data.action === 'save_routing') {
    const d = parsed.data;
    const result = await saveRoutingRow(
      {
        first_approver_id: d.first_approver_id,
        second_approver_id: d.second_approver_id,
        fallback_approver_id: d.fallback_approver_id,
        fallback_after_hours: d.fallback_after_hours,
        active: d.active,
      },
      actor,
    );
    if (!result.ok) return routingReasonToResponse(result.reason);
    return NextResponse.json({ ok: true, id: result.id });
  }

  const result = await setNotificationPref(
    { user_id: parsed.data.user_id, event: parsed.data.event, value: parsed.data.value },
    actor,
  );
  if (!result.ok) return prefReasonToResponse(result.reason);
  return NextResponse.json({ ok: true });
}

// Reason → status. 409 is reserved for "the request named a real account that
// simply cannot hold this role"; 422 is a malformed intent.
function routingReasonToResponse(reason: SaveRoutingReason): NextResponse {
  switch (reason) {
    case 'self_pair':
      return NextResponse.json({ error: AC.errors.selfPair }, { status: 422 });
    case 'self_fallback':
      return NextResponse.json({ error: AC.errors.selfFallback }, { status: 422 });
    case 'first_approver_invalid':
      return NextResponse.json({ error: AC.errors.firstApproverInvalid }, { status: 422 });
    case 'second_approver_unreachable':
      return NextResponse.json({ error: AC.errors.secondApproverUnreachable }, { status: 422 });
    case 'fallback_unreachable':
      return NextResponse.json({ error: AC.errors.fallbackUnreachable }, { status: 422 });
    case 'hours_out_of_range':
      return NextResponse.json({ error: AC.errors.hoursOutOfRange }, { status: 422 });
    case 'user_not_found':
      return NextResponse.json({ error: AC.errors.userNotFound }, { status: 404 });
  }
}

function prefReasonToResponse(reason: SetPrefReason): NextResponse {
  switch (reason) {
    case 'user_not_found':
      return NextResponse.json({ error: AC.errors.userNotFound }, { status: 404 });
    case 'not_an_approver':
      return NextResponse.json({ error: AC.errors.notAnApprover }, { status: 422 });
    case 'event_inert':
      return NextResponse.json({ error: AC.errors.eventInert }, { status: 422 });
  }
}
