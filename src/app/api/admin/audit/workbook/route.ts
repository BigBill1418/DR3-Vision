// ADR-0039 D4 — admin workbook-import endpoint (retro-audit).
//
// Admin-only (admin POWERS stay role=admin per hard rule #2 — never off
// all_sites). The uploaded historical workbook is parsed SERVER-SIDE; only
// staging rows persist (never operational tables). The original xlsx is retained
// in R2 under `workbook-imports/` for evidence, keyed on the import row.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ingestWorkbook } from '@/lib/audit/workbook-import';
import { inMemoryAliasResolver } from '@/lib/audit/workbook/site-alias';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — a monthly workbook is well under this

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected multipart form' }, { status: 400 });

  const file = form.get('file');
  const siteCode = form.get('siteCode');
  const windowStart = form.get('windowStart');
  const windowEnd = form.get('windowEnd');
  const periodLabel = form.get('periodLabel');

  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'file too large' }, { status: 413 });
  if (typeof siteCode !== 'string') return NextResponse.json({ error: 'siteCode is required' }, { status: 400 });
  if (typeof windowStart !== 'string' || !ISO_DAY.test(windowStart)) {
    return NextResponse.json({ error: 'windowStart must be YYYY-MM-DD' }, { status: 400 });
  }
  if (typeof windowEnd !== 'string' || !ISO_DAY.test(windowEnd)) {
    return NextResponse.json({ error: 'windowEnd must be YYYY-MM-DD' }, { status: 400 });
  }

  const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    // The alias resolver is wired to ADR-0037's source_aliases post-merge; until
    // then it resolves nothing, so unknown site names surface honestly as
    // `unresolved_site` findings rather than being dropped.
    const result = await ingestWorkbook({
      db: prisma,
      siteId: site.id,
      uploadedByUserId: session.user.id,
      filename: file.name || 'workbook.xlsx',
      buffer: bytes,
      window: { siteId: site.id, startISO: windowStart, endISO: windowEnd },
      periodLabel: typeof periodLabel === 'string' ? periodLabel : null,
      resolver: inMemoryAliasResolver({}),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse failed';
    return NextResponse.json({ error: 'workbook parse failed', detail: message.slice(0, 300) }, { status: 422 });
  }
}
