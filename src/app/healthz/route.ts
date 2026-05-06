import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Healthcheck endpoint hit by:
//   - Dockerfile HEALTHCHECK
//   - swarmpilot_deployer post-deploy smoke test
//   - Cloudflare Healthcheck (`dr3-vision-public` per cf-healthchecks.yml)
//   - Manual probes (`curl https://dr3-vision.svdp.us/healthz`)
//
// Per ADR-0013 §4 the response shape grows with subsystems:
//   T-001  → { ok, version, uptime_s }
//   T-002  → adds db_ok (this file)
//   T-007  → adds r2_ok
// 200 if every probed subsystem is healthy; 503 if any is down. The
// deployer's smoke test gates rollback on this distinction.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BOOT_TS = Date.now();
const VERSION = process.env['npm_package_version'] ?? '0.1.0';

async function probeDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const db_ok = await probeDb();
  const ok = db_ok;
  return NextResponse.json(
    {
      ok,
      version: VERSION,
      uptime_s: Math.round((Date.now() - BOOT_TS) / 1000),
      db_ok,
    },
    { status: ok ? 200 : 503 },
  );
}
