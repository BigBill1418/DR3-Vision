// ADR-0049 D9 — create a workbook source (admin-only, audited). Born
// is_syncing=false: a deliberate enable (the PATCH toggle) turns real polling on.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { folderPathHasUntokenisedMonth } from '@/lib/workbook-sync/naming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  siteId: z.string().min(1),
  driveUpn: z.string().min(3),
  folderPath: z.string().default(''),
  shareUrl: z.string().url().optional().or(z.literal('')),
  namingPattern: z.string().min(1).default('{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm'),
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
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const d = parsed.data;
  if (untokenisedMonth(d.folderPath)) {
    return NextResponse.json(UNTOKENISED_MONTH_ERROR, { status: 422 });
  }

  const site = await prisma.site.findUnique({ where: { id: d.siteId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site_not_found' }, { status: 404 });
  const existing = await prisma.workbookSource.findUnique({
    where: { site_id: d.siteId },
    select: { id: true },
  });
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
    after: {
      site_id: created.site_id,
      drive_upn: created.drive_upn,
      naming_pattern: created.naming_pattern,
      is_syncing: false,
    },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent'),
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
