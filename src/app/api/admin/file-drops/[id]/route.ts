// O-2 (2026-07-16) — annotate a file-drop: set status (routed/discarded/received)
// and/or edit the note. Admin-only, audited (action=update on file_drops). This is
// how the downstream router records, per-file, what it did with a drop.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    status: z.enum(['received', 'routed', 'discarded']).optional(),
    // null clears the note; a string sets it (trimmed, capped). Omit to leave it.
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.note !== undefined, {
    message: 'nothing to update',
  });

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const d = parsed.data;

  const before = await prisma.fileDrop.findUnique({
    where: { id },
    select: { status: true, note: true },
  });
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const nextNote =
    d.note === undefined ? undefined : d.note === null ? null : d.note.trim() || null;

  const updated = await prisma.fileDrop.update({
    where: { id },
    data: {
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(nextNote !== undefined ? { note: nextNote } : {}),
    },
    select: { id: true, status: true, note: true },
  });

  await writeAudit({
    actor_user_id: admin.userId,
    action: 'update',
    table_name: 'file_drops',
    row_id: id,
    before: { status: before.status, note: before.note },
    after: { status: updated.status, note: updated.note },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent'),
  });

  return NextResponse.json({ id: updated.id, status: updated.status, note: updated.note });
}
