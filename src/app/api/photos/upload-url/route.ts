import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mintUploadUrl } from '@/lib/r2';
import { requireOperatorAtLoadSite } from '@/lib/load-photo-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PHOTO_KINDS = ['bol', 'weight_ticket', 'door_open', 'concern', 'rejection'] as const;

// Constrain content_type to an image allowlist (audit 2026-07-16 · UPLOAD). The
// value is set verbatim on the presigned R2 PUT (src/lib/r2.ts), so an arbitrary
// string let a caller park HTML/SVG that R2 would then serve with an active
// Content-Type on the public photos host. Mirrors r2.ts SAFE_EXT.
const CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

const schema = z.object({
  load_id: z.string().min(1),
  kind: z.enum(PHOTO_KINDS),
  content_type: z.enum(CONTENT_TYPES),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  try {
    // ADR-0078 Am.1 — SITE-scoped, not owner-scoped. Mint and confirm must move
    // together: a relaxed mint with a strict confirm PUTs bytes to R2 and then
    // refuses to write the row, which is strictly worse than today — orphaned
    // objects, no record, and a queue row that still cannot drain.
    await requireOperatorAtLoadSite(parsed.data.load_id);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const minted = await mintUploadUrl({
    loadId: parsed.data.load_id,
    kind: parsed.data.kind,
    contentType: parsed.data.content_type,
  });
  return NextResponse.json(minted);
}
