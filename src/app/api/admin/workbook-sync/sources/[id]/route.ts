// ADR-0049 D9 — edit a workbook source + the enable/disable toggle (admin-only,
// audited). Enabling (`isSyncing=true`) is the deliberate operator action that turns
// real polling on.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  driveUpn: z.string().min(3).optional(),
  folderPath: z.string().optional(),
  shareUrl: z.string().url().optional().or(z.literal('')),
  namingPattern: z.string().min(1).optional(),
  isSyncing: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }
  const d = parsed.data;

  const before = await prisma.workbookSource.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: 'source_not_found' }, { status: 404 });

  const updated = await prisma.workbookSource.update({
    where: { id },
    data: {
      ...(d.driveUpn !== undefined ? { drive_upn: d.driveUpn.trim() } : {}),
      ...(d.folderPath !== undefined ? { folder_path: d.folderPath.trim() } : {}),
      ...(d.shareUrl !== undefined ? { share_url: d.shareUrl ? d.shareUrl.trim() : null } : {}),
      ...(d.namingPattern !== undefined ? { naming_pattern: d.namingPattern.trim() } : {}),
      ...(d.isSyncing !== undefined ? { is_syncing: d.isSyncing } : {}),
      updated_by: admin.userId,
    },
  });

  await writeAudit({
    actor_user_id: admin.userId,
    action: 'update',
    table_name: 'workbook_sources',
    row_id: id,
    before: { is_syncing: before.is_syncing, drive_upn: before.drive_upn, naming_pattern: before.naming_pattern, folder_path: before.folder_path },
    after: { is_syncing: updated.is_syncing, drive_upn: updated.drive_upn, naming_pattern: updated.naming_pattern, folder_path: updated.folder_path },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent'),
  });

  return NextResponse.json({ id: updated.id, is_syncing: updated.is_syncing });
}
