import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { photoGrantsConfigured } from '@/lib/photo-grant';

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
//
// Body contract for the swarmpilot deployer post-deploy gate
// (see noc-master/api/services/deployer-worker.js). The shared default
// regex across 18 fleet repos is `"status"\s*:\s*"(ok|healthy)"`. We
// emit `status:"ok"` on the healthy branch and `status:"degraded"` on
// the failure branch. The latter intentionally does NOT match the
// deployer regex, so a service stuck on db_ok=false fails the gate and
// triggers rollback rather than silently sitting at attempt 90+ until
// the 15-min deadline elapses (observed at commit 9a166b7).

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
      status: ok ? 'ok' : 'degraded',
      ok,
      version: VERSION,
      uptime_s: Math.round((Date.now() - BOOT_TS) / 1000),
      db_ok,
      // ADR-0086 §6.5 — "the app must refuse to mint grants and SAY SO on the
      // health surface", rather than silently degrading to no-grants and
      // reproducing today's behaviour without telling anyone it did.
      //
      // Deliberately NOT part of `ok`/`status`: this feature's first deploy
      // necessarily lands BEFORE the operator drops photo-grant.env, so gating
      // the deployer's smoke test on it would roll the deploy back. False here
      // means "queued photos still need a live session to drain", which is the
      // pre-ADR-0086 status quo, not an outage.
      photo_grants_ok: photoGrantsConfigured(),
    },
    { status: ok ? 200 : 503 },
  );
}
