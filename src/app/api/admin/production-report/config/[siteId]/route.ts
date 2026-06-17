import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { patchConfig, DailyReportConfigError } from '@/lib/bonus/daily-report-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  enabled: z.boolean().optional(),
  sendTimePt: z.string().optional(),
  subjectTemplate: z.string().optional(),
  skipIfZero: z.boolean().optional(),
  skipWeekends: z.boolean().optional(),
  skipHolidays: z.boolean().optional(),
  includeBonusDollars: z.boolean().optional(),
  includeComparisons: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });

  const { siteId } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const cfg = await prisma.bonusDailyReportConfig.findUnique({ where: { site_id: siteId } });
  if (!cfg) return new NextResponse('not_found', { status: 404 });

  try {
    const updated = await patchConfig(cfg.id, parsed.data, {
      userId: session.user.id,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({ config: updated });
  } catch (e) {
    if (e instanceof DailyReportConfigError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
