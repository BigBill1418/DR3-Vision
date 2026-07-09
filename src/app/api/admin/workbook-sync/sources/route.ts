// ADR-0049 D9 — create a workbook source (admin-only, audited). Born
// is_syncing=false: a deliberate enable (the PATCH toggle) turns real polling on.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  siteId: z.string().min(1),
  driveUpn: z.string().min(3),
  folderPath: z.string().default(''),
  shareUrl: z.string().url().optional().or(z.literal('')),
  namingPattern: z.string().min(1).default('{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm'),
});

export async function POST(req: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }
  const d = parsed.data;

  const site = await prisma.site.findUnique({ where: { id: d.siteId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site_not_found' }, { status: 404 });
  const existing = await prisma.workbookSource.findUnique({ where: { site_id: d.siteId }, select: { id: true } });
  if (existing) return NextResponse.json({ error: 'source_exists' }, { status: 409 });

  const created = await prisma.workbookSource.create({
    data: {
      site_id: d.siteId,
      drive_upn: d.driveUpn.trim(),
      folder_path: d.folderPath.trim(),
      share_url: d.shareUrl ? d.shareUrl.trim() : null,
      naming_pattern: d.namingPattern.trim(),
      is_syncing: false,
      created_by: admin.userId,
      updated_by: admin.userId,
    },
  });

  await writeAudit({
    actor_user_id: admin.userId,
    action: 'insert',
    table_name: 'workbook_sources',
    row_id: created.id,
    after: { site_id: created.site_id, drive_upn: created.drive_upn, naming_pattern: created.naming_pattern, is_syncing: false },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent'),
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
