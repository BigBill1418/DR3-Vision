// ADR-0030 — Internal test-send for the daily production report.
//
// Builds today's (Pacific) report for one site and sends the REAL rendered
// email to a single address — for operators to eyeball the branding/quality
// without waiting for the 18:00 fire and without touching the configured
// recipient list. Writes NO bonus_daily_report_log row, so it never blocks the
// scheduled production send.
//
// INTERNAL-ONLY: identical guard to /api/internal/bonus/close-months — any
// request carrying `cf-connecting-ip` (i.e. via the public Cloudflare tunnel)
// gets a 404. Reachable over loopback inside the fleet network. An optional
// `INTERNAL_CRON_TOKEN` adds a bearer check when set.
//
// Body: { "siteCode": "woodland" | "eugene", "to": "name@svdp.us" }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { appToday } from '@/lib/time';
import { buildDailyReport } from '@/lib/bonus/daily-report';
import { sendDailyReport } from '@/lib/bonus/daily-report-notifications';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  siteCode: z.enum(['woodland', 'eugene']),
  to: z.string().email(),
});

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get('cf-connecting-ip')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const requiredToken = process.env['INTERNAL_CRON_TOKEN'];
  if (requiredToken) {
    const authz = req.headers.get('authorization');
    if (authz !== `Bearer ${requiredToken}`) {
      return new NextResponse('Not Found', { status: 404 });
    }
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const site = await prisma.site.findUnique({
    where: { code: parsed.data.siteCode },
    select: { id: true },
  });
  if (!site) return NextResponse.json({ error: 'site_not_found' }, { status: 404 });

  const config = await prisma.bonusDailyReportConfig.findUnique({
    where: { site_id: site.id },
    select: { subject_template: true, include_bonus_dollars: true, include_comparisons: true },
  });

  const report = await buildDailyReport(site.id, appToday());
  const result = await sendDailyReport({
    report,
    recipients: [parsed.data.to],
    subjectTemplate: `[TEST] ${config?.subject_template ?? 'DR3 Daily Production Report — {site} — {date}'}`,
    includeBonusDollars: config?.include_bonus_dollars ?? true,
    includeComparisons: config?.include_comparisons ?? true,
  });

  log.info(
    { siteCode: parsed.data.siteCode, to: parsed.data.to, delivered: result.delivered_count },
    '[daily-report] test send complete',
  );
  return NextResponse.json({ result });
}
