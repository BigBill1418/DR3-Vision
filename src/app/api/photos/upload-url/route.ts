import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mintUploadUrl } from '@/lib/r2';
import { requireOperatorOwnsLoad } from '@/lib/load-photo-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PHOTO_KINDS = ['bol', 'weight_ticket', 'door_open', 'concern', 'rejection'] as const;

const schema = z.object({
  load_id: z.string().min(1),
  kind: z.enum(PHOTO_KINDS),
  content_type: z.string().min(1).max(120),
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
    await requireOperatorOwnsLoad(parsed.data.load_id);
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
