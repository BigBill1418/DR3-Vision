// ADR-0141 D3 — the accounting-staff list a team submission picks from.
//
// GET   — every contact, active and inactive
// POST  — { display_name, email } → a new active contact
// PATCH — { id, display_name?, email?, active? } → edit or (de)activate
//
// Admin-only (an admin POWER: `role === 'admin'`, never `all_sites`). Every
// write is audited inside the service. Contacts are never deleted.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  createAccountingContact,
  listAccountingContacts,
  updateAccountingContact,
  type ContactInputReason,
} from '@/lib/ap/accounting-contacts';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const E = M.apAccounting.errors;

const createSchema = z.object({
  display_name: z.string().max(200),
  email: z.string().max(320),
});
const updateSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  active: z.boolean().optional(),
});

async function admin(): Promise<{ userId: string } | Response> {
  try {
    return await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

function reasonResponse(reason: ContactInputReason): NextResponse {
  const status = reason === 'not_found' ? 404 : reason === 'email_taken' ? 409 : 422;
  return NextResponse.json({ error: E[reason] }, { status });
}

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T | NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : NextResponse.json({ error: M.errors.invalidPayload }, { status: 422 });
}

export async function GET(): Promise<Response> {
  const ctx = await admin();
  if (ctx instanceof Response) return ctx;
  return NextResponse.json({ contacts: await listAccountingContacts() });
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await admin();
  if (ctx instanceof Response) return ctx;
  const data = await body(req, createSchema);
  if (data instanceof NextResponse) return data;
  const result = await createAccountingContact({
    displayName: data.display_name,
    email: data.email,
    actorUserId: ctx.userId,
  });
  return result.ok
    ? NextResponse.json({ contact: result.contact }, { status: 201 })
    : reasonResponse(result.reason);
}

export async function PATCH(req: Request): Promise<Response> {
  const ctx = await admin();
  if (ctx instanceof Response) return ctx;
  const data = await body(req, updateSchema);
  if (data instanceof NextResponse) return data;
  const result = await updateAccountingContact({
    id: data.id,
    ...(data.display_name !== undefined ? { displayName: data.display_name } : {}),
    ...(data.email !== undefined ? { email: data.email } : {}),
    ...(data.active !== undefined ? { active: data.active } : {}),
    actorUserId: ctx.userId,
  });
  return result.ok ? NextResponse.json({ contact: result.contact }) : reasonResponse(result.reason);
}
