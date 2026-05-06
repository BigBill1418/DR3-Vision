import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/argon';
import { verifyResetToken } from '@/lib/password-reset-token';

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(12).max(256),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const verified = verifyResetToken(parsed.data.token);
  if (!verified) {
    return NextResponse.json({ error: 'Reset link is invalid or expired.' }, { status: 400 });
  }

  const hash = await hashPassword(parsed.data.password);
  await prisma.user.update({
    where: { id: verified.userId },
    data: {
      password_hash: hash,
      is_active: true,
    },
  });

  return NextResponse.json({ ok: true });
}
