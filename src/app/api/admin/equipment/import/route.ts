// ADR-0048 D3 — admin Terex equipment-history upload endpoint.
//
// Admin-only (hard rule #2). Accepts an xlsx/csv Terex spreadsheet and imports it
// into `equipment_events` (source='import') via the flexible header-detection
// mapping. Parsing FAILS LOUD (typed 422, listing what it saw) on an unrecognized
// shape; re-uploading the identical file is a no-op (source_sha256). The importer
// is finalized against Janette's real file on receipt — the UI says so.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { importTerexHistory } from '@/lib/equipment/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024; // a Terex history is well under this

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected multipart form' }, { status: 400 });

  const file = form.get('file');
  const siteCode = form.get('siteCode');
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'file too large' }, { status: 413 });
  if (typeof siteCode !== 'string') return NextResponse.json({ error: 'siteCode is required' }, { status: 400 });
  if (!/\.(xlsx|xlsm|csv)$/i.test(file.name || '')) {
    return NextResponse.json({ error: 'file must be .xlsx / .xlsm / .csv' }, { status: 415 });
  }

  const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await importTerexHistory({
      db: prisma,
      siteId: site.id,
      filename: file.name || 'terex.xlsx',
      buffer: bytes,
      importedByUserId: session.user.id,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'import failed';
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 422;
    return NextResponse.json({ error: 'terex import failed', detail: message.slice(0, 400) }, { status });
  }
}
