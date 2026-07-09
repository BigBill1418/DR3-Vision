// ADR-0045 §3 addendum (planning rollup 2026-07-08 §1.8) — board-pack digest send.
//
// Same loopback-guarded internal-route pattern as the AP/survey/bonus crons: a
// request carrying `cf-connecting-ip` (public Cloudflare tunnel) gets a 404; the
// thin `scripts/board-pack-digest-cron.mjs` daemon reaches it over the compose
// network. An optional `INTERNAL_CRON_TOKEN` bearer adds defense in depth.
// `/api/internal/board-pack/` is exempted in public-paths.ts so the auth
// middleware never 307s this session-less POST to /login.
//
// The ROUTE fires daily; `sendBoardPackDigest` decides whether today is a
// board-pack day and whether this period was already sent (idempotent).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendBoardPackDigest } from '@/lib/board-pack/digest';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get('cf-connecting-ip')) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const requiredToken = process.env['INTERNAL_CRON_TOKEN'];
  if (requiredToken) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${requiredToken}`) {
      return new NextResponse('Not Found', { status: 404 });
    }
  }

  const sites = await prisma.site.findMany({ select: { id: true, code: true, name: true } });
  const result = await sendBoardPackDigest({ sites });
  log.info({ op: 'board-pack-send', ...result }, '[board-pack] run complete');
  return NextResponse.json(result);
}
