// ADR-0046 D4 — presigned download for an AP file attachment (org reach). Returns
// a short-lived R2 GET URL; the browser fetches the bytes directly (the app never
// proxies them, hard rule #7). Only `file` attachments with a real R2 key are
// downloadable — reference links are never fetched, and `pending-r2-…` placeholders
// (R2 unconfigured at ingest) return 409.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { signApAttachmentDownload } from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; attId: string }> },
): Promise<Response> {
  try {
    await requireApApprover();
    const { id, attId } = await params;
    const att = await prisma.apAttachment.findFirst({
      where: { id: attId, request_id: id },
      select: { kind: true, storage_key: true },
    });
    if (!att) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (att.kind !== 'file' || !att.storage_key) {
      return NextResponse.json({ error: 'not a downloadable file attachment' }, { status: 409 });
    }
    const url = await signApAttachmentDownload(att.storage_key);
    if (!url) {
      return NextResponse.json({ error: 'attachment not available (R2 unconfigured or placeholder key)' }, { status: 409 });
    }
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
