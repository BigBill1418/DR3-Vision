// ADR-0041 — shared route helpers for the manager invoice surfaces.
//
// Site-scoped (hard rule #2) via `requireManagerForSite`. `resolveApprover`
// refines the session into the D4 `ApproverContext` (manager-of-site or admin;
// super-admin for the gate override). `invoiceErrorResponse` maps the typed
// service/lifecycle errors to their HTTP status and logs every non-2xx.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { log } from '@/lib/observability/logger';
import type { ApproverContext } from './lifecycle';

/**
 * Refine the current session into an approver context for `siteId`. The caller
 * must have already passed `requireManagerForSite` (site reach). `managesSite`
 * is the STRICTER approval rule (D4): admin, or a manager whose primary site IS
 * this site — an all-sites manager has reach but NOT approval authority here.
 */
export async function resolveApprover(siteId: string): Promise<ApproverContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  const role = session.user.role as ApproverContext['role'];
  const managesSite = role === 'admin' || (role === 'manager' && session.user.primary_site_id === siteId);
  return { userId: session.user.id, role, managesSite, superAdmin: session.user.is_super_admin === true };
}

interface StatusError {
  status: number;
  reason?: string;
  message: string;
}

function isStatusError(e: unknown): e is StatusError {
  return typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number';
}

export interface InvoiceErrorContext {
  site?: string;
  id?: string;
  op?: string;
  requestId?: string | null;
}

/**
 * Map a caught error to a JSON response and log it. Typed invoice errors carry a
 * `status`; the gate-blocked error additionally exposes `context.findingCodes`,
 * which we surface in the body so the office sees WHY generation/approval was
 * refused. Anything untyped is logged `error` and re-thrown to the 500 handler.
 */
export function invoiceErrorResponse(e: unknown, ctx: InvoiceErrorContext = {}): NextResponse {
  const base = { site: ctx.site, id: ctx.id, op: ctx.op, request_id: ctx.requestId ?? undefined };
  if (e instanceof Response) {
    const status = e.status;
    log.warn({ ...base, status, reason: e.statusText || 'error' }, '[invoices] request rejected');
    return NextResponse.json({ error: e.statusText || 'error' }, { status });
  }
  if (isStatusError(e)) {
    const reason = e.reason ?? e.message;
    const findingCodes = (e as { context?: { findingCodes?: string[] } }).context?.findingCodes;
    log.warn({ ...base, status: e.status, reason }, '[invoices] request rejected');
    return NextResponse.json(
      { error: reason, ...(findingCodes ? { findingCodes } : {}) },
      { status: e.status },
    );
  }
  log.error({ ...base, err: e }, '[invoices] unexpected error (500)');
  throw e;
}
