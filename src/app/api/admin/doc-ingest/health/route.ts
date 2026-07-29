// ADR-0067 §3.4 — the ingestion-health endpoint.
//
// Answers "is the thing that is supposed to be watching actually watching?" —
// sweep freshness first, subscription state second, access-lost sources and
// failures alongside. See `health.ts` for why that ordering is the point rather
// than a layout choice.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { loadDocIngestHealth } from '@/lib/doc-ingest/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  try {
    return NextResponse.json(await loadDocIngestHealth(prisma));
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
