import { NextResponse } from 'next/server';

// Healthcheck endpoint hit by:
//   - Dockerfile HEALTHCHECK
//   - swarmpilot_deployer post-deploy smoke test
//   - Cloudflare Healthcheck (configured in CF dashboard)
//   - Manual probes (`curl https://dr3-vision.svdp.us/healthz`)
//
// T-001 ships the simplest possible green response. As subsystems come
// online (T-002 Postgres, T-007 R2), each ticket adds its own reachability
// probe to this handler and the response shape grows toward the contract
// in docs/FLEET-DEPLOYMENT.md §"Healthcheck":
//   200 { ok: true,  version, uptime_s, db_ok, r2_ok }
//   503 { ok: false, version, ...subsystem flags }

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BOOT_TS = Date.now();
const VERSION = process.env['npm_package_version'] ?? '0.1.0';

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      version: VERSION,
      uptime_s: Math.round((Date.now() - BOOT_TS) / 1000),
    },
    { status: 200 },
  );
}
