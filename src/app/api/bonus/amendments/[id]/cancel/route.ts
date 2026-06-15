import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { cancelAmendmentRequest, AmendmentRequestError } from '@/lib/bonus/amendment-requests';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  try {
    const updated = await cancelAmendmentRequest(
      id,
      access.userId,
      req.headers.get('x-forwarded-for'),
      req.headers.get('user-agent'),
    );
    return NextResponse.json({ request: updated });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
