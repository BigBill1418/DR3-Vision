// ADR-0045 D1 — task status transition. PATCH { status } with a reach check on
// the task's own site_id (a plain manager may only transition their site's rows;
// org-wide rows require org reach). Audited by the service.

import { NextResponse } from 'next/server';
import type { OpsTaskStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { canWriteRow } from '@/lib/ops/reach';
import { OpsTaskError, reassignTask, transitionTask } from '@/lib/ops/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const STATUSES: OpsTaskStatus[] = ['open', 'done', 'dropped'];

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const identity = await currentOpsViewer();
  if (!identity) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const task = await prisma.opsTask.findUnique({ where: { id }, select: { site_id: true } });
  if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!canWriteRow(identity.viewer, task.site_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as { status?: string; assignee_user_id?: string | null };

  try {
    // Reassignment (2026-07-16): `assignee_user_id` present (a string admin id
    // or null to clear) reassigns; the server re-validates the assignee is an
    // active admin. A status field transitions. Both may be sent together.
    let updated;
    if (Object.prototype.hasOwnProperty.call(body, 'assignee_user_id')) {
      const assignee = body.assignee_user_id ? String(body.assignee_user_id) : null;
      updated = await reassignTask(id, assignee, identity.userId);
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as OpsTaskStatus)) {
        return NextResponse.json({ error: 'invalid_status' }, { status: 422 });
      }
      updated = await transitionTask(id, body.status as OpsTaskStatus, identity.userId);
    }
    if (!updated) return NextResponse.json({ error: 'no_change' }, { status: 422 });
    return NextResponse.json({ task: updated });
  } catch (e) {
    if (e instanceof OpsTaskError)
      return NextResponse.json({ error: e.reason }, { status: e.status });
    throw e;
  }
}
