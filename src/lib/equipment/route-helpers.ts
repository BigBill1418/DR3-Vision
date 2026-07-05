// ADR-0044 — route helpers for the manager equipment surface.
//
// Equipment is a plain MANAGER surface (site-scoped, hard rule #2) — it is NOT
// behind the ADR-0037 D7 loads/inventory activation gate, so it uses
// `requireManagerForSite` directly (manager-on-own-site or admin). The error
// mapper mirrors `loadsErrorResponse` but tags its log line `[equipment]` so a
// non-2xx is diagnosable to this surface.

import { NextResponse } from 'next/server';
import { log } from '@/lib/observability/logger';

interface StatusError {
  status: number;
  message: string;
}

function isStatusError(e: unknown): e is StatusError {
  return typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number';
}

export interface EquipmentErrorContext {
  site?: string;
  id?: string;
  op?: string;
  requestId?: string | null;
}

/**
 * Parse `?limit=` into a bounded row count (bad/absent → fallback, hard-capped at
 * `max` so no request can force an unbounded scan).
 */
export function clampLimit(raw: string | null | undefined, fallback: number, max = 200): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Map a caught error to a JSON response + log it. Auth `Response`s and typed
 * service errors (carrying `status`) surface as such (logged `warn`); anything
 * else is logged `error` and re-thrown to the framework 500 handler.
 */
export function equipmentErrorResponse(e: unknown, ctx: EquipmentErrorContext = {}): NextResponse {
  const base = { site: ctx.site, id: ctx.id, op: ctx.op, request_id: ctx.requestId ?? undefined };
  if (e instanceof Response) {
    log.warn({ ...base, status: e.status, reason: e.statusText || 'error' }, '[equipment] request rejected');
    return NextResponse.json({ error: e.statusText || 'error' }, { status: e.status });
  }
  if (isStatusError(e)) {
    log.warn({ ...base, status: e.status, reason: e.message }, '[equipment] request rejected');
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  log.error({ ...base, err: e }, '[equipment] unexpected error (500)');
  throw e;
}
