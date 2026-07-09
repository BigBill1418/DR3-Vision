// ADR-0046 D4 — AP request detail (org reach). Returns the sanitized body (for
// the sandboxed-iframe render), attachments, and follow-ups.

import { NextResponse } from 'next/server';
import { requireApApprover } from '@/lib/ap/approvers';
import { getApRequestDetail } from '@/lib/ap/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireApApprover();
    const { id } = await params;
    const detail = await getApRequestDetail(id);
    if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ request: detail });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
