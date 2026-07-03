// ADR-0037 D5 — processed_units_daily entry/list API (office desktop,
// SUPER-ADMIN gated per mission §3). GET lists a site's recent rows; POST
// upserts the (site, day) row (blocked after close by the service layer).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  upsertProcessedUnits,
  listProcessedUnits,
  ProcessedUnitsError,
} from '@/lib/loads/processed-units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  site: z.string().min(1),
  productionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strippedProgram: z.number().nonnegative(),
  strippedNonProgram: z.number().nonnegative(),
  savedUnits: z.number().nonnegative().nullable().optional(),
  materialTicketNumber: z.string().max(120).nullable().optional(),
  employeesCount: z.number().int().nonnegative().nullable().optional(),
  processorsCount: z.number().int().nonnegative().nullable().optional(),
  pocketcoilEstimate: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

async function siteIdForCode(code: string): Promise<string | null> {
  const site = await prisma.site.findUnique({ where: { code }, select: { id: true } });
  return site?.id ?? null;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const code = new URL(req.url).searchParams.get('site');
  if (!code) return NextResponse.json({ error: 'site required' }, { status: 400 });
  const siteId = await siteIdForCode(code);
  if (!siteId) return NextResponse.json({ error: 'site not found' }, { status: 404 });
  return NextResponse.json({ rows: await listProcessedUnits(siteId) });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  const siteId = await siteIdForCode(parsed.data.site);
  if (!siteId) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  try {
    const row = await upsertProcessedUnits({
      siteId,
      productionDate: new Date(`${parsed.data.productionDate}T00:00:00Z`),
      strippedProgram: parsed.data.strippedProgram,
      strippedNonProgram: parsed.data.strippedNonProgram,
      savedUnits: parsed.data.savedUnits ?? null,
      materialTicketNumber: parsed.data.materialTicketNumber ?? null,
      employeesCount: parsed.data.employeesCount ?? null,
      processorsCount: parsed.data.processorsCount ?? null,
      pocketcoilEstimate: parsed.data.pocketcoilEstimate ?? null,
      actorUserId: session.user.id,
      notes: parsed.data.notes ?? null,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    if (e instanceof ProcessedUnitsError) return NextResponse.json({ error: e.reason }, { status: e.status });
    throw e;
  }
}
