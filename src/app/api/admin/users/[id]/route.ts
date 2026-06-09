// ADR-0017 — admin Settings panel: per-user mutation endpoint.
//
// PATCH  /api/admin/users/[id]   — discriminated union by `action`
// DELETE /api/admin/users/[id]   — alias for { action: 'deactivate' }
//
// PATCH actions:
//   { action: 'update', name?, role?, email?, primary_site_id?, processor_role? }
//   { action: 'reset_pin', pin }
//   { action: 'deactivate' }
//   { action: 'reactivate' }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  PROCESSOR_ROLES,
  deactivateUser,
  reactivateUser,
  resetUserPin,
  updateUser,
  type UpdateUserInput,
} from '@/lib/admin-users';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['operator', 'manager', 'admin'] as const;

const optionalEmail = z
  .union([z.string().email(), z.literal(''), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    return v;
  });

const optionalProcessorRole = z
  .union([z.enum(PROCESSOR_ROLES), z.literal(''), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    return v;
  });

const updateAction = z.object({
  action: z.literal('update'),
  name: z.string().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  email: optionalEmail,
  primary_site_id: z.string().min(1).optional(),
  processor_role: optionalProcessorRole,
  all_sites: z.boolean().optional(), // ADR-0024 (manager-only; coerced in the model)
});

const resetPinAction = z.object({
  action: z.literal('reset_pin'),
  pin: z.string().regex(/^\d{4}$/),
});

const deactivateAction = z.object({ action: z.literal('deactivate') });
const reactivateAction = z.object({ action: z.literal('reactivate') });

const patchSchema = z.discriminatedUnion('action', [
  updateAction,
  resetPinAction,
  deactivateAction,
  reactivateAction,
]);

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
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

  const ctx = await requireAdmin();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;
  const actor = { actorUserId: ctx.userId, ip, userAgent };

  switch (parsed.data.action) {
    case 'update': {
      const input: UpdateUserInput = {};
      if (parsed.data.name !== undefined) input.name = parsed.data.name;
      if (parsed.data.role !== undefined) input.role = parsed.data.role;
      if (parsed.data.email !== undefined) input.email = parsed.data.email;
      if (parsed.data.primary_site_id !== undefined)
        input.primary_site_id = parsed.data.primary_site_id;
      if (parsed.data.processor_role !== undefined)
        input.processor_role = parsed.data.processor_role;
      if (parsed.data.all_sites !== undefined) input.all_sites = parsed.data.all_sites;

      const r = await updateUser(id, input, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ user: r.user });
    }
    case 'reset_pin': {
      const r = await resetUserPin(id, parsed.data.pin, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ ok: true });
    }
    case 'deactivate': {
      const r = await deactivateUser(id, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ user: r.user });
    }
    case 'reactivate': {
      const r = await reactivateUser(id, actor);
      if (!r.ok) return reasonToResponse(r.reason);
      return NextResponse.json({ user: r.user });
    }
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  const ctx = await requireAdmin();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;

  const r = await deactivateUser(id, { actorUserId: ctx.userId, ip, userAgent });
  if (!r.ok) return reasonToResponse(r.reason);
  return NextResponse.json({ user: r.user });
}

function reasonToResponse(reason: string): NextResponse {
  switch (reason) {
    case 'not_found':
      return NextResponse.json({ error: M.errors.notFound }, { status: 404 });
    case 'not_operator':
      return NextResponse.json({ error: M.errors.notOperator }, { status: 422 });
    case 'self_deactivate':
      return NextResponse.json({ error: M.errors.selfDeactivate }, { status: 422 });
    case 'email_required':
      return NextResponse.json({ error: M.form.emailRequired }, { status: 422 });
    case 'email_taken':
      return NextResponse.json({ error: M.form.emailTaken }, { status: 409 });
    case 'pin_invalid_pattern':
      return NextResponse.json({ error: M.form.pinInvalidPattern }, { status: 422 });
    case 'pin_collision_within_site':
      return NextResponse.json({ error: M.form.pinCollision }, { status: 409 });
    case 'site_not_found':
      return NextResponse.json({ error: M.errors.siteNotFound }, { status: 422 });
    default:
      return NextResponse.json({ error: M.errors.serverError }, { status: 500 });
  }
}
