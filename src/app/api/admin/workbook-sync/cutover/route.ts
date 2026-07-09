// ADR-0049 D7 — cutover control (admin-only). Flips the site's workbook_sync
// surface to `live` (sync stops) and fires R2 archival (via the shared flip hook).
// Soft-gated on Rick's parity signoff: refused unless `overrideNoParity` is passed
// with the UI's warning acknowledged. The criteria note is mandatory.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { cutoverWorkbookSync, CutoverError } from '@/lib/workbook-sync/cutover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  siteId: z.string().min(1),
  criteriaNote: z.string().min(3),
  overrideNoParity: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const result = await cutoverWorkbookSync({
      siteId: parsed.data.siteId,
      criteriaNote: parsed.data.criteriaNote,
      overrideNoParity: parsed.data.overrideNoParity,
      actorUserId: admin.userId,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CutoverError) return NextResponse.json({ error: e.reason }, { status: e.status });
    throw e;
  }
}
