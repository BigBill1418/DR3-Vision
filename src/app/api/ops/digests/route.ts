// ADR-0045 D2 — Updates/board digests list (org reach: admin or all_sites).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrgReach } from '@/lib/ops/viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await requireOrgReach();
    const rows = await prisma.updateDigest.findMany({
      orderBy: [{ period_start: 'desc' }, { kind: 'asc' }],
      select: {
        id: true,
        kind: true,
        period_start: true,
        period_end: true,
        status: true,
        finalized_at: true,
        updated_at: true,
      },
    });
    return NextResponse.json({ rows });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
