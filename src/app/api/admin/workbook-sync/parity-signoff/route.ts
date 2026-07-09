// ADR-0049 D7 — record Rick's parity signoff for a site (admin-only, append-only
// audit marker). Clears the cutover soft-gate warning for that site.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { recordParitySignoff } from '@/lib/workbook-sync/parity-signoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  siteId: z.string().min(1),
  note: z.string().min(3),
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
  await recordParitySignoff({ siteId: parsed.data.siteId, actorUserId: admin.userId, note: parsed.data.note });
  return NextResponse.json({ ok: true });
}
