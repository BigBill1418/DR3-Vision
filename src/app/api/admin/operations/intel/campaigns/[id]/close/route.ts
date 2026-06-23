import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { closeCampaign, SurveyCampaignError } from '@/lib/survey/campaigns';
import { buildExport } from '@/lib/survey/export';
import { log } from '@/lib/observability/logger';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const exportOnly = url.searchParams.get('export_only') === 'true';

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    if (!exportOnly) {
      await closeCampaign(id, { userId: session.user.id, ip, userAgent });
    }
    const files = await buildExport(id);
    for (const f of files) {
      log.info({ path: f.path, bytes: f.body.length }, '[survey] export ready');
    }
    // The actual ClaudeSync push is wired in a follow-up via a queued job that
    // calls into the ClaudeSync write tool path the operator already uses.
    // For now we surface the files in the response so the operator can review.
    return NextResponse.json({
      ok: true,
      files: files.map((f) => ({ path: f.path, bytes: f.body.length })),
    });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
