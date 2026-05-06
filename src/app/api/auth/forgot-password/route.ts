import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { issueResetToken } from '@/lib/password-reset-token';
import { sendEmail } from '@/lib/email';

const schema = z.object({ email: z.string().email() });

// The handler always returns 200 regardless of whether the email is
// in the system. This preserves the front-end "if an account exists,
// a link is on its way" behavior so the endpoint can't be used as an
// account-existence oracle.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, name: true, is_active: true },
  });

  if (user && user.is_active && user.email) {
    const token = issueResetToken(user.id);
    const base = process.env['NEXTAUTH_URL'] ?? 'https://dr3-vision.svdp.us';
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    await sendEmail({
      to: user.email,
      subject: 'DR3-Vision password reset',
      text: `Hi ${user.name},\n\nA password reset was requested for your DR3-Vision account.\n\nReset link (valid for 15 minutes):\n${link}\n\nIf you didn't request this, ignore this email — your password is unchanged.`,
    });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
