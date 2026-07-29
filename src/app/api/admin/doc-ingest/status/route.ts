// ADR-0067 Amendment A §A.6 — connect-surface status endpoint.
//
// GET /api/admin/doc-ingest/status — admin-only.
//
// Returns `getDocIngestConnectionStatus`, which SELECTs no ciphertext column at
// all. The response physically cannot carry a token, because the token is not
// in the query. Tenant/client/UPN/object ids ARE in the body and that is
// correct — §A.1 states they are not secrets.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import {
  docIngestRedirectUri,
  getDocIngestConnectionStatus,
  type DocIngestConnectionStatus,
} from '@/lib/doc-ingest';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DocIngestStatusResponse extends DocIngestConnectionStatus {
  redirectUri: string;
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  try {
    const status = await getDocIngestConnectionStatus(prisma);
    const body: DocIngestStatusResponse = { ...status, redirectUri: docIngestRedirectUri() };
    return NextResponse.json(body, { status: 200 });
  } catch {
    // Never leak internals (a decrypt/key error message can describe the store).
    return NextResponse.json({ error: M.errors.serverError }, { status: 500 });
  }
}
