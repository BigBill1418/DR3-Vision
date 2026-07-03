// ADR-0037 D5 — close a processed_units_daily day (super-admin). Stamps
// closed_at + audit; post-close edits are then blocked by the service layer.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { childLogger, newRequestId } from '@/lib/observability/logger';
import { closeProcessedUnitsDay, ProcessedUnitsError } from '@/lib/loads/processed-units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `acknowledgeNegative` waves through a close that would drive inventory negative
// (an upstream data gap) — recorded in the close audit row (D6 warn-and-confirm).
const Body = z.object({ site: z.string().min(1), acknowledgeNegative: z.boolean().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rlog = childLogger(req.headers.get('x-request-id') ?? newRequestId());
  const { id } = await params;
  const session = await auth();
  const actor = session?.user?.id ?? null;
  if (!session?.user?.is_super_admin || !session.user.id) {
    rlog.warn({ op: 'processed-units.close', actor, id, status: 403, reason: 'forbidden' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    rlog.warn({ op: 'processed-units.close', actor, id, status: 422, reason: 'invalid_input' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const site = await prisma.site.findUnique({ where: { code: parsed.data.site }, select: { id: true } });
  if (!site) {
    rlog.warn(
      { op: 'processed-units.close', actor, id, site: parsed.data.site, status: 404, reason: 'site_not_found' },
      '[processed-units] rejected',
    );
    return NextResponse.json({ error: 'site not found' }, { status: 404 });
  }

  try {
    const row = await closeProcessedUnitsDay({
      id,
      siteId: site.id,
      actorUserId: session.user.id,
      ...(parsed.data.acknowledgeNegative !== undefined ? { acknowledgeNegative: parsed.data.acknowledgeNegative } : {}),
    });
    return NextResponse.json({ row });
  } catch (e) {
    if (e instanceof ProcessedUnitsError) {
      rlog.warn(
        { op: 'processed-units.close', actor, id, site: parsed.data.site, status: e.status, reason: e.reason },
        '[processed-units] rejected',
      );
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    rlog.error({ op: 'processed-units.close', actor, id, site: parsed.data.site, err: e }, '[processed-units] unexpected error (500)');
    throw e;
  }
}
