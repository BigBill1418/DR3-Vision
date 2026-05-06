import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireOperatorOwnsLoad } from '@/lib/load-photo-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PHOTO_KINDS = ['bol', 'weight_ticket', 'door_open', 'concern', 'rejection'] as const;

const schema = z.object({
  load_id: z.string().min(1),
  kind: z.enum(PHOTO_KINDS),
  storage_key: z.string().min(1).max(512),
  byte_size: z.number().int().min(0).max(50_000_000).nullable().optional(),
  width: z.number().int().min(1).max(20_000).nullable().optional(),
  height: z.number().int().min(1).max(20_000).nullable().optional(),
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

  const created = await prisma.loadPhoto.create({
    data: {
      load_id: parsed.data.load_id,
      kind: parsed.data.kind,
      storage_key: parsed.data.storage_key,
      byte_size: parsed.data.byte_size ?? null,
      width: parsed.data.width ?? null,
      height: parsed.data.height ?? null,
      captured_at: new Date(),
    },
    select: { id: true },
  });
  return NextResponse.json({ id: created.id });
}
