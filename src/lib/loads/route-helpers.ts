// ADR-0037 — shared route helpers for the manager loads/inventory surfaces.
//
// `requireActivatedManager` layers the D7 activation gate (data-driven via the
// ADR-0047 `loads_inventory` rollout surface) on top of the canonical site/role
// guard. `loadsErrorResponse` maps the typed service errors to their HTTP status
// so every route reports uniformly.

import { NextResponse } from 'next/server';
import {
  requireManagerForSite,
  requireOperatorForSite,
  type ManagerSiteContext,
  type OperatorSiteContext,
} from '@/lib/auth-helpers';
import { assertLoadsInventoryActivated, LoadsInventoryNotActivatedError } from '@/lib/loads/record-guards';
import { log } from '@/lib/observability/logger';

/**
 * Resolve the manager/site context AND enforce the ADR-0037 D7 activation gate.
 * Throws a `Response` on any failure (unauth/forbidden/not-activated) so route
 * handlers can `return` it directly.
 */
export async function requireActivatedManager(siteCode: string): Promise<ManagerSiteContext> {
  const ctx = await requireManagerForSite(siteCode);
  try {
    await assertLoadsInventoryActivated(ctx.role, ctx.siteId);
  } catch (e) {
    if (e instanceof LoadsInventoryNotActivatedError) throw new Response('not_activated', { status: e.status });
    throw e;
  }
  return ctx;
}

/**
 * ADR-0060 — the FLOOR (operator) analogue of {@link requireActivatedManager}. Resolves
 * the operator/site context AND enforces the same ADR-0047 per-site `loads_inventory`
 * rollout gate, so the iPad floor surfaces flip live per site exactly like the manager
 * desktop surfaces. Throws a `Response` on any failure (unauth/forbidden/not-activated).
 */
export async function requireActivatedOperator(siteCode: string): Promise<OperatorSiteContext> {
  const ctx = await requireOperatorForSite(siteCode);
  try {
    await assertLoadsInventoryActivated('operator', ctx.siteId);
  } catch (e) {
    if (e instanceof LoadsInventoryNotActivatedError) throw new Response('not_activated', { status: e.status });
    throw e;
  }
  return ctx;
}

/**
 * Parse a client-supplied `?limit=` into a bounded row count. A non-integer, ≤0,
 * or absurd value falls back to `fallback`; the result is hard-capped at `max` so
 * no request can force an unbounded scan of the manager list surfaces.
 */
export function clampLimit(raw: string | null | undefined, fallback: number, max = 200): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** A typed service error carrying an HTTP `status`. */
interface StatusError {
  status: number;
  reason?: string;
  message: string;
}

function isStatusError(e: unknown): e is StatusError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    typeof (e as { status: unknown }).status === 'number'
  );
}

/** Diagnostic context a route threads into {@link loadsErrorResponse}. */
export interface LoadsErrorContext {
  /** Site code from the route params. */
  site?: string;
  /** Record id, when the route is record-scoped. */
  id?: string;
  /** Short operation tag, e.g. 'dropoffs.create' or 'loads.verify'. */
  op?: string;
  /** `x-request-id` (middleware-set) for Loki correlation. */
  requestId?: string | null;
}

/**
 * Map a caught error to a JSON response AND log it so every non-2xx is diagnosable
 * later. Typed service errors (RecordValidationError, RecordLockedError,
 * VerifyGateError, …) carry a `status` and are surfaced as such (logged `warn` with
 * reason/status); an auth/activation `Response` is surfaced with its status (logged
 * `warn`); anything else is logged `error` (unexpected 500) and re-thrown to the
 * framework 500 handler. `ctx` threads the site/id/op so the line is actionable.
 */
export function loadsErrorResponse(e: unknown, ctx: LoadsErrorContext = {}): NextResponse {
  const base = { site: ctx.site, id: ctx.id, op: ctx.op, request_id: ctx.requestId ?? undefined };
  if (e instanceof Response) {
    const status = e.status;
    log.warn({ ...base, status, reason: e.statusText || 'error' }, '[loads] request rejected');
    return NextResponse.json({ error: e.statusText || 'error' }, { status });
  }
  if (isStatusError(e)) {
    const reason = e.reason ?? e.message;
    log.warn({ ...base, status: e.status, reason }, '[loads] request rejected');
    return NextResponse.json({ error: reason }, { status: e.status });
  }
  log.error({ ...base, err: e }, '[loads] unexpected error (500)');
  throw e;
}
