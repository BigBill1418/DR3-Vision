// ADR-0046 Amendment 5 (D-M5-4) — baseline-import PREVIEW (admin-only, no write).
//
// Step 1 of the two-step import: the admin picks a Bill-uploaded AP-report PDF from
// file-drop; this route fetches its bytes from R2 and parses them into preview rows
// (local pdf-parse tabular parse, with the Claude structuring fallback when the key
// is configured and the local parse is thin). NOTHING is written — the admin reviews
// the rows, then POSTs them to the confirm route. Admin-only (hard rule #2).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { getFileDropBytes } from '@/lib/r2';
import { parseBaselinePdf } from '@/lib/ap/baseline-import';
import { apExtractionFallbackEnabled } from '@/lib/ap/extraction/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PreviewBody {
  fileDropId?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const body = (await req.json().catch(() => null)) as PreviewBody | null;
  const fileDropId = body?.fileDropId;
  if (typeof fileDropId !== 'string' || !fileDropId) {
    return NextResponse.json({ error: 'fileDropId is required' }, { status: 400 });
  }

  const drop = await prisma.fileDrop.findUnique({
    where: { id: fileDropId },
    select: { id: true, original_filename: true, content_type: true, r2_key: true },
  });
  if (!drop) return NextResponse.json({ error: 'file-drop not found' }, { status: 404 });

  const bytes = await getFileDropBytes(drop.r2_key);
  if (!bytes) {
    return NextResponse.json(
      { error: 'file is not retrievable (R2 unconfigured or a placeholder key)' },
      { status: 409 },
    );
  }

  const parsed = await parseBaselinePdf(Buffer.from(bytes), {
    fallbackEnabled: apExtractionFallbackEnabled(),
  });
  return NextResponse.json({
    fileDropId: drop.id,
    filename: drop.original_filename,
    source: parsed.source,
    rows: parsed.rows,
    unparsedLines: parsed.unparsedLines.slice(0, 50),
    unparsedCount: parsed.unparsedLines.length,
  });
}
