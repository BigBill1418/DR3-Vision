// ADR-0037 — shared route helpers for the manager loads/inventory surfaces.
//
// `requireActivatedManager` layers the D7 activation gate (admin-only for now)
// on top of the canonical site/role guard. `loadsErrorResponse` maps the typed
// service errors to their HTTP status so every route reports uniformly.

import { NextResponse } from 'next/server';
import { requireManagerForSite, type ManagerSiteContext } from '@/lib/auth-helpers';
import { assertLoadsInventoryActivated, LoadsInventoryNotActivatedError } from '@/lib/loads/record-guards';

/**
 * Resolve the manager/site context AND enforce the ADR-0037 D7 activation gate.
 * Throws a `Response` on any failure (unauth/forbidden/not-activated) so route
 * handlers can `return` it directly.
 */
export async function requireActivatedManager(siteCode: string): Promise<ManagerSiteContext> {
  const ctx = await requireManagerForSite(siteCode);
  try {
    assertLoadsInventoryActivated(ctx.role);
  } catch (e) {
    if (e instanceof LoadsInventoryNotActivatedError) throw new Response('not_activated', { status: e.status });
    throw e;
  }
  return ctx;
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

/**
 * Map a caught error to a JSON response. Typed service errors
 * (RecordValidationError, RecordLockedError, VerifyGateError, …) carry a `status`
 * and are surfaced as such; anything else re-throws to the framework 500 handler.
 */
export function loadsErrorResponse(e: unknown): NextResponse {
  if (e instanceof Response) {
    return NextResponse.json({ error: e.statusText || 'error' }, { status: e.status });
  }
  if (isStatusError(e)) {
    return NextResponse.json({ error: e.reason ?? e.message }, { status: e.status });
  }
  throw e;
}
