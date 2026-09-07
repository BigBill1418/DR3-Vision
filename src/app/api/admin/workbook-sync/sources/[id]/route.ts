// ADR-0049 D9 — edit a workbook source + the enable/disable toggle (admin-only,
// audited). Enabling (`isSyncing=true`) is the deliberate operator action that turns
// real polling on.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { folderPathHasUntokenisedMonth } from '@/lib/workbook-sync/naming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  driveUpn: z.string().min(3).optional(),
  folderPath: z.string().optional(),
  shareUrl: z.string().url().optional().or(z.literal('')),
  namingPattern: z.string().min(1).optional(),
  isSyncing: z.boolean().optional(),
});

/**
 * ADR-0130 D10 — a `folder_path` that names a month literally but carries no `{…}`
 * token is refused on save.
 *
 * That shape is a latent time-bomb: correct this month, silently wrong the next.
 * The live Woodland row held `…/2026 Daily Logs/August 2026 Woodland`, so when the
 * file name rolled to SEPTEMBER on 2026-09-01 the transport went on asking for
 * September's file inside August's folder — 393 consecutive failed polls. ADR-0102
 * §5 specified the tokenised value and the code implements it; the row was never
 * migrated. The migration `20260860_adr0130_workbook_resolved_folder` re-tokenises
 * the existing rows; this guard is what stops one being typed back in.
 */
const untokenisedMonth = (folderPath: string | undefined): boolean =>
  folderPath !== undefined && folderPathHasUntokenisedMonth(folderPath.trim());

const UNTOKENISED_MONTH_ERROR = {
  error: 'folder_path_untokenised_month',
  detail:
    'This folder path names a month literally and carries no {MONTH_TITLE}/{YEAR} token, ' +
    'so it would be correct this month and silently wrong next month (ADR-0102 §5, ADR-0130 D10). ' +
    'Use e.g. "DR3/Woodland/Woodland Operations/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland".',
} as const;

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
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const d = parsed.data;
  if (untokenisedMonth(d.folderPath)) {
    return NextResponse.json(UNTOKENISED_MONTH_ERROR, { status: 422 });
  }

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
    before: {
      is_syncing: before.is_syncing,
      drive_upn: before.drive_upn,
      naming_pattern: before.naming_pattern,
      folder_path: before.folder_path,
    },
    after: {
      is_syncing: updated.is_syncing,
      drive_upn: updated.drive_upn,
      naming_pattern: updated.naming_pattern,
      folder_path: updated.folder_path,
    },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent'),
  });

  return NextResponse.json({ id: updated.id, is_syncing: updated.is_syncing });
}
