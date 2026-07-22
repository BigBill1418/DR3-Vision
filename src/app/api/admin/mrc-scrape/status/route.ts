// ADR-0057 — MRC-Scrape status surface (admin-only).
//
// Read-only health view for /admin/mrc-scrape: credential state (configured or
// not — NEVER the password/ciphertext), the most recent sync run from the
// ledger, and per-object mirror row counts + freshness. Vision has never pulled
// from MyMRC, so the ledger is empty on first load: `neverRun` is surfaced so
// the UI renders an honest "no sync has run yet" state rather than a fake
// "healthy". Credential state comes from `getMymrcCredentialStatus`, whose query
// selects no password column — ciphertext never leaves Postgres on this path.
//
// Admin-only (role=admin) per hard rule #2 — matches every other /admin/* route.
//
// Import note: pulled from the specific `credential-store` module, NOT the
// `@/lib/mymrc` barrel — the barrel re-exports `portal-client`, which imports
// Playwright at module load, and the Next.js app process must never bundle it.

import { NextResponse } from 'next/server';
import type { MymrcSyncStatus } from '@prisma/client';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { getMymrcCredentialStatus } from '@/lib/mymrc/credential-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The three MyMRC object mirrors that exist today. ADR-0057 defers the
// remaining object mirrors to Phase 0 live discovery, so only these are counted.
export type MirrorObject = 'hauls' | 'processed' | 'outbound';

export interface MrcObjectCount {
  object: MirrorObject;
  count: number;
  lastSeenAt: string | null; // ISO 8601, or null when the mirror is empty
}

export interface MrcLastRun {
  status: MymrcSyncStatus; // 'ok' | 'auth_failed' | 'contract_drift' | 'error'
  feed: string;
  siteId: string;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
  rowsListed: number;
  rowsUpserted: number;
  detailsFetched: number;
  error: string | null; // human text; never contains credentials
}

export interface MrcCredentialState {
  configured: boolean;
  username: string | null;
  updatedAt: string | null; // ISO 8601
  updatedBy: string | null;
}

export interface MrcScrapeStatusResponse {
  credential: MrcCredentialState;
  lastRun: MrcLastRun | null;
  neverRun: boolean; // true when the ledger is empty (Vision has never pulled)
  objectCounts: MrcObjectCount[];
}

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const [credential, lastRunRow, hauls, processed, outbound] = await Promise.all([
    getMymrcCredentialStatus(prisma),
    prisma.mymrcSyncRun.findFirst({ orderBy: { started_at: 'desc' } }),
    prisma.mymrcHaulsMirror.aggregate({ _count: true, _max: { last_seen_at: true } }),
    prisma.mymrcProcessedMirror.aggregate({ _count: true, _max: { last_seen_at: true } }),
    prisma.mymrcOutboundMirror.aggregate({ _count: true, _max: { last_seen_at: true } }),
  ]);

  const objectCounts: MrcObjectCount[] = [
    { object: 'hauls', count: hauls._count, lastSeenAt: hauls._max.last_seen_at?.toISOString() ?? null },
    {
      object: 'processed',
      count: processed._count,
      lastSeenAt: processed._max.last_seen_at?.toISOString() ?? null,
    },
    {
      object: 'outbound',
      count: outbound._count,
      lastSeenAt: outbound._max.last_seen_at?.toISOString() ?? null,
    },
  ];

  const lastRun: MrcLastRun | null = lastRunRow
    ? {
        status: lastRunRow.status,
        feed: lastRunRow.feed,
        siteId: lastRunRow.site_id,
        startedAt: lastRunRow.started_at.toISOString(),
        finishedAt: lastRunRow.finished_at?.toISOString() ?? null,
        rowsListed: lastRunRow.rows_listed,
        rowsUpserted: lastRunRow.rows_upserted,
        detailsFetched: lastRunRow.details_fetched,
        error: lastRunRow.error,
      }
    : null;

  const body: MrcScrapeStatusResponse = {
    credential: {
      configured: credential.configured,
      username: credential.username,
      updatedAt: credential.updatedAt?.toISOString() ?? null,
      updatedBy: credential.updatedBy,
    },
    lastRun,
    neverRun: lastRunRow === null,
    objectCounts,
  };

  return NextResponse.json(body);
}
