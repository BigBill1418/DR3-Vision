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
import {
  assertLoadsInventoryActivated,
  assertUiSurfaceActivated,
  LoadsInventoryNotActivatedError,
} from '@/lib/loads/record-guards';
import type { UiSurfaceCode } from '@/lib/notify/rollout';
import { log } from '@/lib/observability/logger';
import { pacificDayISO } from '@/lib/time';

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
    if (e instanceof LoadsInventoryNotActivatedError)
      throw new Response('not_activated', { status: e.status });
    throw e;
  }
  return ctx;
}

/**
 * ADR-0060 / ADR-0065 — the FLOOR (operator) analogue of {@link requireActivatedManager}.
 * Resolves the operator/site context AND enforces the ADR-0047 per-site rollout gate for
 * the NAMED surface. Throws a `Response` on any failure (unauth/forbidden/not-activated).
 *
 * `surfaceCode` is REQUIRED — there is deliberately no default. Under ADR-0060 every
 * floor write shared the `loads_inventory` master gate, which is also the manager
 * desktop's gate; ADR-0065 split them so one iPad screen can be turned off without
 * dropping the managers' tabs. A default would silently re-couple them, so each caller
 * must name the surface it is the write path for.
 */
export async function requireActivatedOperator(
  siteCode: string,
  surfaceCode: UiSurfaceCode,
): Promise<OperatorSiteContext> {
  const ctx = await requireOperatorForSite(siteCode);
  try {
    await assertUiSurfaceActivated('operator', surfaceCode, ctx.siteId);
  } catch (e) {
    if (e instanceof LoadsInventoryNotActivatedError)
      throw new Response('not_activated', { status: e.status });
    throw e;
  }
  return ctx;
}

/**
 * ADR-0065 — the floor iPad is CURRENT-DAY ONLY: "no historical or future
 * views" (Bill, 2026-07-28). Hiding other days in the UI is not enough — the
 * floor APIs take the target day in the request body, so an operator (or
 * anything replaying a stale offline-queue entry) could reach another day by
 * editing it. This is the server-side pin.
 *
 * Throws a `Response` (422 `date_not_today`) unless `dayValue` is the CURRENT
 * Pacific calendar day. Pacific, not server-local: the container runs UTC, so a
 * server-local comparison would start rejecting the operator's real day at 5 PM
 * Pacific and accepting tomorrow's.
 *
 * Money-safety note: this refuses a WRITE to a non-current day rather than
 * silently rewriting it to today. Silently retargeting a submitted count would
 * file units against the wrong production day.
 */
export function assertCurrentPacificDay(dayValue: string, now: Date = new Date()): void {
  if (dayValue !== pacificDayISO(now)) {
    // The reason rides in `statusText`, not the body: `loadsErrorResponse` reads
    // `e.statusText` when mapping a thrown Response to JSON, so a body-only
    // Response (the older `new Response('not_activated', …)` shape) surfaces as
    // a bare "error" with the reason dropped.
    throw new Response(null, { status: 422, statusText: 'date_not_today' });
  }
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
