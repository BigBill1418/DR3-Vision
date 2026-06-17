// Test send: builds the report for today's Pacific day and sends it to
// the requesting admin's email ONLY (not the configured recipient list).
// Does NOT create a bonus_daily_report_log row — test sends are not
// production sends and must not block tonight's scheduled send.

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { appToday } from '@/lib/time';
import { buildDailyReport } from '@/lib/bonus/daily-report';
import { sendDailyReport } from '@/lib/bonus/daily-report-notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });
  if (!session.user.email)
    return NextResponse.json({ error: 'no_email_on_account' }, { status: 422 });

  const { siteId } = await ctx.params;
  const cfg = await prisma.bonusDailyReportConfig.findUnique({ where: { site_id: siteId } });
  if (!cfg) return new NextResponse('not_found', { status: 404 });

  const report = await buildDailyReport(siteId, appToday());
  const result = await sendDailyReport({
    report,
    recipients: [session.user.email],
    subjectTemplate: `[TEST] ${cfg.subject_template}`,
    includeBonusDollars: cfg.include_bonus_dollars,
    includeComparisons: cfg.include_comparisons,
  });

  return NextResponse.json({ result });
}
