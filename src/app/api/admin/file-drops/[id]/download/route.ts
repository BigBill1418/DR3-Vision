// O-2 (2026-07-16) — presigned download for a file-drop object (admin-only).
// Returns a short-lived R2 GET URL; the browser fetches the bytes directly (the
// app never proxies them, hard rule #7). Mirrors the AP attachment download route.
//
// A `pending-r2-…` placeholder key (R2 was unconfigured at capture) has no object
// to fetch → 409. Unknown id → 404.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { signFileDropDownload } from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { id } = await params;
    const drop = await prisma.fileDrop.findUnique({
      where: { id },
      select: { r2_key: true, content_type: true },
    });
    if (!drop) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const url = await signFileDropDownload(drop.r2_key, {
      inline: false,
      contentType: drop.content_type,
    });
    if (!url) {
      return NextResponse.json(
        { error: 'object not available (R2 unconfigured or placeholder key)' },
        { status: 409 },
      );
    }
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
