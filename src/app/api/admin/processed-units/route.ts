// ADR-0037 D5 — processed_units_daily entry/list API (office desktop,
// SUPER-ADMIN gated per mission §3). GET lists a site's recent rows; POST
// upserts the (site, day) row (blocked after close by the service layer).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { childLogger, newRequestId } from '@/lib/observability/logger';
import { clampLimit } from '@/lib/loads/route-helpers';
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
  const rlog = childLogger(req.headers.get('x-request-id') ?? newRequestId());
  const session = await auth();
  const actor = session?.user?.id ?? null;
  if (!session?.user?.is_super_admin) {
    rlog.warn({ op: 'processed-units.list', actor, status: 403, reason: 'forbidden' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const code = new URL(req.url).searchParams.get('site');
  if (!code) {
    rlog.warn({ op: 'processed-units.list', actor, status: 400, reason: 'site_required' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'site required' }, { status: 400 });
  }
  const siteId = await siteIdForCode(code);
  if (!siteId) {
    rlog.warn({ op: 'processed-units.list', actor, site: code, status: 404, reason: 'site_not_found' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'site not found' }, { status: 404 });
  }
  const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 60);
  return NextResponse.json({ rows: await listProcessedUnits(siteId, limit) });
}

export async function POST(req: Request) {
  const rlog = childLogger(req.headers.get('x-request-id') ?? newRequestId());
  const session = await auth();
  const actor = session?.user?.id ?? null;
  if (!session?.user?.is_super_admin || !session.user.id) {
    rlog.warn({ op: 'processed-units.upsert', actor, status: 403, reason: 'forbidden' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    rlog.warn({ op: 'processed-units.upsert', actor, status: 422, reason: 'invalid_input' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const siteId = await siteIdForCode(parsed.data.site);
  if (!siteId) {
    rlog.warn({ op: 'processed-units.upsert', actor, site: parsed.data.site, status: 404, reason: 'site_not_found' }, '[processed-units] rejected');
    return NextResponse.json({ error: 'site not found' }, { status: 404 });
  }

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
    if (e instanceof ProcessedUnitsError) {
      rlog.warn(
        { op: 'processed-units.upsert', actor, site: parsed.data.site, status: e.status, reason: e.reason },
        '[processed-units] rejected',
      );
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    rlog.error({ op: 'processed-units.upsert', actor, site: parsed.data.site, err: e }, '[processed-units] unexpected error (500)');
    throw e;
  }
}
