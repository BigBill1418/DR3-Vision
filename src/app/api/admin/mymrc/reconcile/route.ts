// ADR-0057 D4 — reconciliation queue: pending list. Admin-only (anonymous → 401,
// non-admin → 403). Optional `?mirror_table=` + `?change_kind=` filters (the D4
// filtered pending view). Read-only — decisions go through the [id]/decide route.

import { NextResponse } from 'next/server';
import type { ReconChangeKind } from '@prisma/client';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { listPendingReconciliations } from '@/lib/reconcile/apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANGE_KINDS: readonly ReconChangeKind[] = ['new_record', 'field_update', 'disappeared'];

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const mirrorTable = url.searchParams.get('mirror_table')?.trim() || undefined;
  const changeKindRaw = url.searchParams.get('change_kind')?.trim() || undefined;
  if (changeKindRaw && !CHANGE_KINDS.includes(changeKindRaw as ReconChangeKind)) {
    return NextResponse.json({ error: 'invalid change_kind' }, { status: 400 });
  }

  const items = await listPendingReconciliations({
    prisma,
    ...(mirrorTable ? { mirrorTable } : {}),
    ...(changeKindRaw ? { changeKind: changeKindRaw as ReconChangeKind } : {}),
  });
  return NextResponse.json({ items });
}
