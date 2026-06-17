import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listConfigs } from '@/lib/bonus/daily-report-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });
  const configs = await listConfigs();
  return NextResponse.json({ configs });
}
