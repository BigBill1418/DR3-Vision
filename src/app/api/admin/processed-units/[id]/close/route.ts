// ADR-0037 D5 — close a processed_units_daily day (super-admin). Stamps
// closed_at + audit; post-close edits are then blocked by the service layer.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { closeProcessedUnitsDay, ProcessedUnitsError } from '@/lib/loads/processed-units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ site: z.string().min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  const site = await prisma.site.findUnique({ where: { code: parsed.data.site }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  const { id } = await params;
  try {
    const row = await closeProcessedUnitsDay({ id, siteId: site.id, actorUserId: session.user.id });
    return NextResponse.json({ row });
  } catch (e) {
    if (e instanceof ProcessedUnitsError) return NextResponse.json({ error: e.reason }, { status: e.status });
    throw e;
  }
}
