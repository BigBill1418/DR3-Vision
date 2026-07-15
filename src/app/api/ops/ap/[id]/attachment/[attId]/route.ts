// ADR-0046 D4 — presigned download for an AP file attachment (org reach). Returns
// a short-lived R2 GET URL; the browser fetches the bytes directly (the app never
// proxies them, hard rule #7). Only `file` attachments with a real R2 key are
// downloadable — reference links are never fetched, and `pending-r2-…` placeholders
// (R2 unconfigured at ingest) return 409.
//
// ADR-0046 Amendment 4 — inline preview. The allowlist below is enforced
// SERVER-SIDE off the stored `content_type`: only pdf / png / jpeg / webp get an
// inline Content-Disposition URL (so the approver's browser previews them in a
// frame/img); every other type keeps the plain download URL. The `inline` flag +
// `contentType` are returned so the client picks the right render branch.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { signApAttachmentDownload } from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Content types safe to preview inline (framed PDF / <img>). Server-enforced. */
const INLINE_PREVIEWABLE = /^application\/pdf$|^image\/(png|jpeg|jpg|webp)$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; attId: string }> },
): Promise<Response> {
  try {
    await requireApApprover();
    const { id, attId } = await params;
    const att = await prisma.apAttachment.findFirst({
      where: { id: attId, request_id: id },
      select: { kind: true, storage_key: true, content_type: true },
    });
    if (!att) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (att.kind !== 'file' || !att.storage_key) {
      return NextResponse.json({ error: 'not a downloadable file attachment' }, { status: 409 });
    }
    const inline = !!att.content_type && INLINE_PREVIEWABLE.test(att.content_type);
    const url = await signApAttachmentDownload(att.storage_key, {
      inline,
      contentType: att.content_type,
    });
    if (!url) {
      return NextResponse.json(
        { error: 'attachment not available (R2 unconfigured or placeholder key)' },
        { status: 409 },
      );
    }
    return NextResponse.json({ url, inline, contentType: att.content_type });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
