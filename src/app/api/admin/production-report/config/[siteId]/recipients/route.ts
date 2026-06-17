import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  addRecipient,
  removeRecipient,
  DailyReportConfigError,
} from '@/lib/bonus/daily-report-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PostBody = z.object({ email: z.string().email() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });

  const { siteId } = await ctx.params;
  const cfg = await prisma.bonusDailyReportConfig.findUnique({ where: { site_id: siteId } });
  if (!cfg) return new NextResponse('not_found', { status: 404 });

  const parsed = PostBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }

  try {
    const created = await addRecipient(cfg.id, parsed.data.email, {
      userId: session.user.id,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({ recipient: created }, { status: 201 });
  } catch (e) {
    if (e instanceof DailyReportConfigError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 422 });

  try {
    await removeRecipient(id, {
      userId: session.user.id,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof DailyReportConfigError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
