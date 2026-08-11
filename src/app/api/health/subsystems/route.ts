// Per-subsystem health for the Vision Dashboard footer pill (ADR-0020 / T-120).
//
// Managers/admins only (audit 2026-07-16 · HEALTH). Middleware authenticates any
// operator PIN session, so this route ALSO checks the role explicitly — otherwise
// an operator could read the subsystem config-presence map. Lightweight by design:
// the database is probed live; the rest are configuration-presence checks (a deep
// live probe of every dependency on each 30s dashboard poll would be wasteful and
// could itself cause load). Each subsystem reports green (healthy/configured),
// amber (not configured / degraded), or red (down). Overall = the worst status.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { getMymrcCredentialStatus } from '@/lib/mymrc/credential-store';
import { loadChainHealth } from '@/lib/bonus/chain-health';

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

// ADR-0057 — MyMRC creds now live in the DB store (entered at /admin/mrc-scrape),
// NOT MYMRC_*_USERNAME/PASSWORD env. Read the non-secret status (no password/
// ciphertext leaves Postgres). A DB error here should not turn the whole pill red
// (probeDb already owns the DB-down signal) — degrade this one subsystem to amber.
async function probeMymrc(): Promise<Subsystem> {
  try {
    const { configured } = await getMymrcCredentialStatus(prisma);
    return {
      key: 'mymrc',
      label: 'MyMRC scrape',
      status: configured ? 'green' : 'amber',
      detail: configured ? 'Credentials configured' : 'Not configured',
    };
  } catch {
    return { key: 'mymrc', label: 'MyMRC scrape', status: 'amber', detail: 'Unknown' };
  }
}

// ADR-0019.4 — the check ADR-0019.1 §4 promised and T-120 never added.
//
// This is the ONE subsystem here that is a live correctness probe rather than a
// config-presence check, and it earns the exception: the thing it watches broke
// payroll twice (2026-07-07, 2026-08-04) and was invisible both times until the
// 08:30 PT auto-override declined to run. It is two indexed reads plus one
// `user.findMany` over ~4 ids, which is cheaper than the `SELECT 1` above.
//
// A DB error degrades to amber rather than red: probeDb already owns the
// DB-down signal, and duplicating it here would double-count one outage.
async function probeSignatureChain(): Promise<Subsystem> {
  try {
    const report = await loadChainHealth(prisma);
    const broken = report.sites.filter((s) => s.status !== 'green');
    if (broken.length === 0) {
      const actors = [...new Set(report.sites.map((s) => s.autoOverrideActorName))].join(', ');
      return {
        key: 'signature-chain',
        label: 'Bonus signature chain',
        status: 'green',
        detail: `Override actor available (${actors})`,
      };
    }
    return {
      key: 'signature-chain',
      label: 'Bonus signature chain',
      // report.overall already applies worst-wins across sites, including the
      // empty-set → red rule.
      status: report.overall === 'red' ? 'red' : 'amber',
      detail: broken.map((s) => `${s.siteName}: ${s.findings[0]?.reason ?? 'unknown'}`).join('; '),
    };
  } catch {
    return {
      key: 'signature-chain',
      label: 'Bonus signature chain',
      status: 'amber',
      detail: 'Unknown',
    };
  }
}

function worst(subs: Subsystem[]): Status {
  if (subs.some((s) => s.status === 'red')) return 'red';
  if (subs.some((s) => s.status === 'amber')) return 'amber';
  return 'green';
}

export async function GET(): Promise<Response> {
  const s = await auth();
  if (s?.user?.role !== 'manager' && s?.user?.role !== 'admin') {
    return new NextResponse('forbidden', { status: 403 });
  }

  const r2 = present('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET');
  const ntfy = present('NTFY_PUBLISHER_TOKEN');
  const graph = present(
    'AUTH_MICROSOFT_ENTRA_ID_ID',
    'AUTH_MICROSOFT_ENTRA_ID_SECRET',
    'M365_MAIL_FROM_ADDRESS',
  );
  const glitchtip = present('GLITCHTIP_DSN');

  const [db, mymrc, chain] = await Promise.all([probeDb(), probeMymrc(), probeSignatureChain()]);

  const subsystems: Subsystem[] = [
    db,
    {
      key: 'r2',
      label: 'Photo storage (R2)',
      status: r2 ? 'green' : 'amber',
      detail: r2 ? 'Configured' : 'Not configured',
    },
    mymrc,
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
    chain,
  ];

  return NextResponse.json(
    { overall: worst(subsystems), subsystems },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
