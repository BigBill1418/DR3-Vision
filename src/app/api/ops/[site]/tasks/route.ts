// ADR-0045 D1 — ops tasks API (site-scoped). GET lists the task queue with
// optional filters (status / assignee / overdue); POST creates a manual task.

import { NextResponse } from 'next/server';
import type { OpsTaskStatus } from '@prisma/client';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { canWriteRow } from '@/lib/ops/reach';
import { createTask, listTasks, type ListTasksFilter } from '@/lib/ops/tasks';
import { appToday } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ site: string }> };

const STATUSES: OpsTaskStatus[] = ['open', 'done', 'dropped'];

function dayKeyFromISO(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const { site } = await ctx.params;
    const mgr = await requireManagerForSite(site);
    const id = await currentOpsViewer();
    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status');
    const status = STATUSES.includes(statusParam as OpsTaskStatus)
      ? (statusParam as OpsTaskStatus)
      : undefined;
    const overdueOnly = url.searchParams.get('overdue') === '1';
    const assignee = url.searchParams.get('assignee');
    const filter: ListTasksFilter = { overdueOnly, today: appToday() };
    if (status) filter.status = status;
    if (assignee) filter.assigneeUserId = assignee;
    const rows = await listTasks(id!.viewer, mgr.siteId, filter);
    return NextResponse.json({ rows });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

interface TaskBody {
  title?: string;
  body?: string;
  assignee_user_id?: string;
  due_date?: string;
  org_wide?: boolean;
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const { site } = await ctx.params;
    const mgr = await requireManagerForSite(site);
    const id = await currentOpsViewer();
    const body = (await req.json()) as TaskBody;
    if (!body.title || body.title.trim() === '') {
      return NextResponse.json({ error: 'title_required' }, { status: 422 });
    }
    const siteId = body.org_wide === true ? null : mgr.siteId;
    if (!canWriteRow(id!.viewer, siteId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const task = await createTask({
      siteId,
      title: body.title,
      body: body.body ?? null,
      assigneeUserId: body.assignee_user_id ?? null,
      dueDate: body.due_date ? dayKeyFromISO(body.due_date) : null,
      source: 'manual',
      createdBy: id!.userId,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
