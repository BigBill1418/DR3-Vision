// ADR-0045 D1 — ops tasks service (the follow-up queue).
//
// Tasks are site-scoped or org-wide (site_id NULL); reach via `reachWhere`
// (hard rule #2). Reminders are in-app + digest, NEVER push (hard rule #5):
// `dueSummary` feeds the dashboard tile and the ADR-0043 digest's tasks section.
// Status transitions are audited on `ops_tasks`. `createNoteWithTasks` is the
// meeting → action-items motion: one note + N tasks in a single transaction.

import type { OpsTaskSource, OpsTaskStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { reachWhere, type OpsViewer } from './reach';

export interface CreateTaskInput {
  siteId: string | null;
  title: string;
  body?: string | null;
  assigneeUserId?: string | null;
  dueDate?: Date | null; // @db.Date-shaped
  source?: OpsTaskSource;
  noteId?: string | null;
  createdBy: string;
}

export async function createTask(input: CreateTaskInput) {
  const task = await prisma.opsTask.create({
    data: {
      site_id: input.siteId,
      title: input.title,
      body: input.body ?? null,
      assignee_user_id: input.assigneeUserId ?? null,
      due_date: input.dueDate ?? null,
      source: input.source ?? 'manual',
      note_id: input.noteId ?? null,
      created_by: input.createdBy,
    },
  });
  await writeAudit({
    actor_user_id: input.createdBy,
    action: 'insert',
    table_name: 'ops_tasks',
    row_id: task.id,
    after: {
      site_id: task.site_id,
      title: task.title,
      source: task.source,
      due_date: task.due_date,
      note_id: task.note_id,
    },
  });
  return task;
}

export interface ActionItemInput {
  title: string;
  body?: string | null;
  assigneeUserId?: string | null;
  dueDate?: Date | null;
}

/**
 * Meeting → action items: create one note and N `source=meeting` tasks in a
 * SINGLE transaction (all-or-nothing). Audit rows are written after commit
 * (append-only log, not part of the business transaction).
 */
export async function createNoteWithTasks(
  input: {
    siteId: string | null;
    noteDate: Date;
    title?: string | null;
    body: string;
    authorUserId: string;
  },
  actionItems: ActionItemInput[],
) {
  const { note, tasks } = await prisma.$transaction(async (tx) => {
    const note = await tx.opsNote.create({
      data: {
        site_id: input.siteId,
        note_date: input.noteDate,
        title: input.title ?? null,
        body: input.body,
        author_user_id: input.authorUserId,
      },
    });
    const tasks = [];
    for (const item of actionItems) {
      tasks.push(
        await tx.opsTask.create({
          data: {
            site_id: input.siteId,
            title: item.title,
            body: item.body ?? null,
            assignee_user_id: item.assigneeUserId ?? null,
            due_date: item.dueDate ?? null,
            source: 'meeting',
            note_id: note.id,
            created_by: input.authorUserId,
          },
        }),
      );
    }
    return { note, tasks };
  });

  await writeAudit({
    actor_user_id: input.authorUserId,
    action: 'insert',
    table_name: 'ops_notes',
    row_id: note.id,
    after: { site_id: note.site_id, title: note.title, task_count: tasks.length },
  });
  for (const t of tasks) {
    await writeAudit({
      actor_user_id: input.authorUserId,
      action: 'insert',
      table_name: 'ops_tasks',
      row_id: t.id,
      after: { site_id: t.site_id, title: t.title, source: 'meeting', note_id: note.id },
    });
  }
  return { note, tasks };
}

export class OpsTaskError extends Error {
  constructor(
    public reason: string,
    public status: 404 | 403 | 409,
  ) {
    super(reason);
    this.name = 'OpsTaskError';
  }
}

/**
 * Transition a task's status, audited. `done` records completed_at/completed_by;
 * `open`/`dropped` clear them. A no-op (same status) is rejected 409 so the audit
 * trail never records empty transitions.
 */
export async function transitionTask(
  id: string,
  toStatus: OpsTaskStatus,
  actorUserId: string,
  now: Date = new Date(),
) {
  const before = await prisma.opsTask.findUnique({ where: { id } });
  if (!before) throw new OpsTaskError('not_found', 404);
  if (before.status === toStatus) throw new OpsTaskError('no_change', 409);

  const done = toStatus === 'done';
  const task = await prisma.opsTask.update({
    where: { id },
    data: {
      status: toStatus,
      completed_at: done ? now : null,
      completed_by: done ? actorUserId : null,
    },
  });
  await writeAudit({
    actor_user_id: actorUserId,
    action: 'update',
    table_name: 'ops_tasks',
    row_id: id,
    before: { status: before.status },
    after: { status: task.status, completed_at: task.completed_at, completed_by: task.completed_by },
  });
  return task;
}

export interface ListTasksFilter {
  status?: OpsTaskStatus;
  assigneeUserId?: string;
  overdueOnly?: boolean;
  today?: Date; // @db.Date-shaped; required when overdueOnly
}

/** List tasks visible to `viewer` on a site page, with optional queue filters. */
export function listTasks(viewer: OpsViewer, siteId: string, filter: ListTasksFilter = {}) {
  const where: Prisma.OpsTaskWhereInput = reachWhere(viewer, siteId);
  if (filter.status) where.status = filter.status;
  if (filter.assigneeUserId) where.assignee_user_id = filter.assigneeUserId;
  if (filter.overdueOnly && filter.today) {
    where.status = 'open';
    where.due_date = { lt: filter.today };
  }
  return prisma.opsTask.findMany({
    where,
    orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'desc' }],
  });
}

export interface DueTask {
  id: string;
  siteId: string | null;
  title: string;
  dueDate: Date | null;
  assigneeUserId: string | null;
  overdue: boolean;
}

export interface DueSummary {
  overdue: DueTask[];
  dueToday: DueTask[];
}

/**
 * Open tasks that are overdue (due_date < today) or due today, for one site's
 * reach (site rows + org-wide when the viewer has org reach). Feeds the
 * dashboard tile AND the ADR-0043 digest tasks section. `viewer` is optional:
 * the digest fire passes org-reach semantics via `includeOrgWide`.
 */
export async function dueSummaryForSite(
  siteId: string,
  today: Date,
  includeOrgWide: boolean,
): Promise<DueSummary> {
  const siteClause: Prisma.OpsTaskWhereInput = includeOrgWide
    ? { OR: [{ site_id: siteId }, { site_id: null }] }
    : { site_id: siteId };
  const rows = await prisma.opsTask.findMany({
    where: { AND: [siteClause, { status: 'open', due_date: { lte: today } }] },
    orderBy: [{ due_date: 'asc' }],
    select: { id: true, site_id: true, title: true, due_date: true, assignee_user_id: true },
  });
  const overdue: DueTask[] = [];
  const dueToday: DueTask[] = [];
  const todayMs = today.getTime();
  for (const r of rows) {
    const d: DueTask = {
      id: r.id,
      siteId: r.site_id,
      title: r.title,
      dueDate: r.due_date,
      assigneeUserId: r.assignee_user_id,
      overdue: r.due_date !== null && r.due_date.getTime() < todayMs,
    };
    (d.overdue ? overdue : dueToday).push(d);
  }
  return { overdue, dueToday };
}
