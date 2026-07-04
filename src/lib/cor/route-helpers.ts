// ADR-0042 — shared route helpers for the manager COR surfaces.
//
// Site-scoped (hard rule #2) via `requireManagerForSite` at the route. `resolveFinalizer`
// refines the session into the D3 `FinalizerContext` (manager-of-site or admin —
// an all-sites manager has reach but NOT finalize authority here, mirroring the
// ADR-0041 approver rule). `corErrorResponse` maps the typed service/lifecycle
// errors to their HTTP status and logs every non-2xx.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { log } from '@/lib/observability/logger';
import type { FinalizerContext } from './lifecycle';

/**
 * Refine the current session into a finalizer context for `siteId`. The caller
 * must have already passed `requireManagerForSite` (site reach). `managesSite` is
 * the STRICTER finalize rule (D3): admin, or a manager whose primary site IS this
 * site — an all-sites manager has reach but NOT finalize authority.
 */
export async function resolveFinalizer(siteId: string): Promise<FinalizerContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  const role = session.user.role as FinalizerContext['role'];
  const managesSite = role === 'admin' || (role === 'manager' && session.user.primary_site_id === siteId);
  return { userId: session.user.id, role, managesSite };
}

export interface CorErrorContext {
  site?: string;
  id?: string;
  op?: string;
  requestId?: string | null;
}

interface StatusError {
  status: number;
  reason?: string;
  message: string;
}

function isStatusError(e: unknown): e is StatusError {
  return typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number';
}

/**
 * Map a caught error to a JSON response and log it. Typed COR errors carry a
 * `status`; the reconcile-mismatch error additionally exposes `context` with both
 * numbers, which we surface in the body so the office sees WHY finalize/render was
 * refused. Anything untyped is logged `error` and re-thrown to the 500 handler.
 */
export function corErrorResponse(e: unknown, ctx: CorErrorContext = {}): NextResponse {
  const base = { site: ctx.site, id: ctx.id, op: ctx.op, request_id: ctx.requestId ?? undefined };
  if (e instanceof Response) {
    const status = e.status;
    log.warn({ ...base, status, reason: e.statusText || 'error' }, '[cor] request rejected');
    return NextResponse.json({ error: e.statusText || 'error' }, { status });
  }
  if (isStatusError(e)) {
    const reason = e.reason ?? e.message;
    const reconcile = (e as { context?: { storedUnits?: number; recomputedUnits?: number } }).context;
    log.warn({ ...base, status: e.status, reason }, '[cor] request rejected');
    return NextResponse.json(
      {
        error: reason,
        ...(reconcile && typeof reconcile.storedUnits === 'number'
          ? { storedUnits: reconcile.storedUnits, recomputedUnits: reconcile.recomputedUnits }
          : {}),
      },
      { status: e.status },
    );
  }
  log.error({ ...base, err: e }, '[cor] unexpected error (500)');
  throw e;
}
