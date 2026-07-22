// ADR-0057 — MyMRC admin-credential surface: save endpoint.
//
// POST /api/admin/mrc-scrape/credentials — set (or replace) the single MyMRC
// admin credential the hourly portal scrape reads. Admin-only: anonymous → 401,
// authenticated non-admin → 403.
//
// The plaintext password NEVER leaves this process in a response body or a log
// line — the store encrypts it, and this handler returns only `{ ok, warning? }`.
// MyMRC rejects leading/trailing whitespace, so both fields are TRIMMED before
// storage; when trimming actually changed a value the client is warned so the
// operator knows what was persisted.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { setMymrcCredentials, InvalidCredentialInputError } from '@/lib/mymrc';
import { adminMessages as M } from '@/app/admin/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const saveSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: Request) {
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

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: M.errors.invalidPayload, details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  // MyMRC rejects leading/trailing whitespace on the login. Trim before storing
  // (the store persists exactly what it is given), and flag when trimming
  // changed a value so the operator knows the stored form differs from input.
  const username = parsed.data.username.trim();
  const password = parsed.data.password.trim();
  const trimmed = username !== parsed.data.username || password !== parsed.data.password;

  if (!username) {
    return NextResponse.json({ error: M.mrc.usernameRequired }, { status: 422 });
  }
  if (!password) {
    return NextResponse.json({ error: M.mrc.passwordRequired }, { status: 422 });
  }

  try {
    await setMymrcCredentials(prisma, { username, password }, ctx.userId);
  } catch (e) {
    if (e instanceof InvalidCredentialInputError) {
      return NextResponse.json({ error: M.errors.invalidPayload }, { status: 422 });
    }
    // Key-unavailable / decrypt / unexpected → generic 500 (never leak internals).
    return NextResponse.json({ error: M.errors.serverError }, { status: 500 });
  }

  return NextResponse.json(
    { ok: true, ...(trimmed ? { warning: M.mrc.whitespaceTrimmed } : {}) },
    { status: 200 },
  );
}
