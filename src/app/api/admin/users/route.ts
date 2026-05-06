// ADR-0017 — admin Settings panel: create + list endpoints.
//
// POST /api/admin/users        — create a user
// GET  /api/admin/users        — list users (filters via query params)
//
// Both gates: role=admin only. Anonymous -> 401, authenticated
// non-admin -> 403. The body of each route re-checks via
// `requireAdmin()`; the middleware-level redirect to /login covers
// the page surface, but never the API layer.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  PROCESSOR_ROLES,
  createUser,
  listUsers,
  type CreateUserInput,
  type ListFilters,
} from '@/lib/admin-users';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['operator', 'manager', 'admin'] as const;

// Allow either omitted, null, or empty-string for optional fields;
// the model layer normalizes empty-string -> null where appropriate.
const optionalEmail = z
  .union([z.string().email(), z.literal('')])
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

const optionalProcessorRole = z
  .union([z.enum(PROCESSOR_ROLES), z.literal('')])
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

const optionalPin = z
  .union([z.string().regex(/^\d{4}$/), z.literal('')])
  .optional()
  .transform((v) => (v && v.length === 4 ? v : null));

const createSchema = z.object({
  name: z.string().min(1).max(120),
  role: z.enum(ROLES),
  email: optionalEmail,
  primary_site_id: z.string().min(1),
  processor_role: optionalProcessorRole,
  pin: optionalPin,
});

const listQuerySchema = z.object({
  site: z.string().optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
});

export async function POST(req: Request) {
  try {
    await requireAdmin();
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: M.errors.invalidPayload, details: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const ctx = await requireAdmin(); // re-fetch to get the ID for actor
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;

  const input: CreateUserInput = {
    name: parsed.data.name,
    role: parsed.data.role,
    email: parsed.data.email,
    primary_site_id: parsed.data.primary_site_id,
    processor_role: parsed.data.processor_role,
    pin: parsed.data.pin,
  };

  const result = await createUser(input, {
    actorUserId: ctx.userId,
    ip,
    userAgent,
  });
  if (!result.ok) return reasonToResponse(result.reason);
  return NextResponse.json({ user: result.user }, { status: 201 });
}

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    site: url.searchParams.get('site') ?? undefined,
    role: url.searchParams.get('role') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }

  const filters: ListFilters = {
    siteId: parsed.data.site,
    role: parsed.data.role,
    status: parsed.data.status,
  };
  const users = await listUsers(filters);
  return NextResponse.json({ users });
}

// Reason -> HTTP status mapping. Kept in this file so each route
// gets the same vocabulary; the model layer's reason taxonomy is the
// source of truth.
function reasonToResponse(reason: string): NextResponse {
  switch (reason) {
    case 'email_required':
      return NextResponse.json({ error: M.form.emailRequired }, { status: 422 });
    case 'email_taken':
      return NextResponse.json({ error: M.form.emailTaken }, { status: 409 });
    case 'pin_required':
      return NextResponse.json({ error: M.form.pinRequired }, { status: 422 });
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
