// Per-subsystem health for the Vision Dashboard footer pill (ADR-0020 / T-120).
//
// Behind the normal /api auth gate (managers/admins only). Lightweight by design:
// the database is probed live; the rest are configuration-presence checks (a deep
// live probe of every dependency on each 30s dashboard poll would be wasteful and
// could itself cause load). Each subsystem reports green (healthy/configured),
// amber (not configured / degraded), or red (down). Overall = the worst status.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = 'green' | 'amber' | 'red';
interface Subsystem {
  key: string;
  label: string;
  status: Status;
  detail: string;
}

function present(...keys: string[]): boolean {
  return keys.every((k) => Boolean(process.env[k]?.trim()));
}

async function probeDb(): Promise<Subsystem> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { key: 'db', label: 'Database', status: 'green', detail: 'Reachable' };
  } catch {
    return { key: 'db', label: 'Database', status: 'red', detail: 'Unreachable' };
  }
}

function worst(subs: Subsystem[]): Status {
  if (subs.some((s) => s.status === 'red')) return 'red';
  if (subs.some((s) => s.status === 'amber')) return 'amber';
  return 'green';
}

export async function GET(): Promise<Response> {
  const r2 = present('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET');
  const mymrc =
    present('MYMRC_WOODLAND_USERNAME', 'MYMRC_WOODLAND_PASSWORD') ||
    present('MYMRC_CA_USERNAME', 'MYMRC_CA_PASSWORD');
  const ntfy = present('NTFY_PUBLISHER_TOKEN');
  const graph = present(
    'AUTH_MICROSOFT_ENTRA_ID_ID',
    'AUTH_MICROSOFT_ENTRA_ID_SECRET',
    'M365_MAIL_FROM_ADDRESS',
  );
  const glitchtip = present('GLITCHTIP_DSN');

  const subsystems: Subsystem[] = [
    await probeDb(),
    {
      key: 'r2',
      label: 'Photo storage (R2)',
      status: r2 ? 'green' : 'amber',
      detail: r2 ? 'Configured' : 'Not configured',
    },
    {
      key: 'mymrc',
      label: 'MyMRC scrape',
      status: mymrc ? 'green' : 'amber',
      detail: mymrc ? 'Credentials configured' : 'Not configured',
    },
    {
      key: 'ntfy',
      label: 'ntfy publisher',
      status: ntfy ? 'green' : 'amber',
      detail: ntfy ? 'Token configured' : 'Not configured',
    },
    {
      key: 'graph',
      label: 'M365 mail (Graph)',
      status: graph ? 'green' : 'amber',
      detail: graph ? 'Configured' : 'Not configured',
    },
    {
      key: 'glitchtip',
      label: 'GlitchTip errors',
      status: glitchtip ? 'green' : 'amber',
      detail: glitchtip ? 'DSN configured' : 'Not configured',
    },
  ];

  return NextResponse.json(
    { overall: worst(subsystems), subsystems },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
