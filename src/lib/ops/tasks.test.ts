import { beforeEach, describe, expect, it, vi } from 'vitest';

const taskCreate = vi.fn();
const taskUpdate = vi.fn();
const taskFindUnique = vi.fn();
const taskFindMany = vi.fn();
const userFindMany = vi.fn();
const userFindFirst = vi.fn();
const noteCreate = vi.fn();
const txTaskCreate = vi.fn();
const txNoteCreate = vi.fn();
const transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn({ opsNote: { create: txNoteCreate }, opsTask: { create: txTaskCreate } }),
);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    opsTask: {
      create: (...a: unknown[]) => taskCreate(...a),
      update: (...a: unknown[]) => taskUpdate(...a),
      findUnique: (...a: unknown[]) => taskFindUnique(...a),
      findMany: (...a: unknown[]) => taskFindMany(...a),
    },
    opsNote: { create: (...a: unknown[]) => noteCreate(...a) },
    user: {
      findMany: (...a: unknown[]) => userFindMany(...a),
      findFirst: (...a: unknown[]) => userFindFirst(...a),
    },
    $transaction: (fn: (tx: unknown) => unknown) => transaction(fn),
  },
}));

const writeAudit = vi.fn();
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

import {
  assertAssignableAdmin,
  createNoteWithTasks,
  createTask,
  dueSummaryForSite,
  listAssignableAdmins,
  OpsTaskError,
  reassignTask,
  transitionTask,
} from './tasks';

const DAY = new Date(Date.UTC(2026, 6, 6)); // 2026-07-06

beforeEach(() => {
  vi.clearAllMocks();
  taskCreate.mockResolvedValue({
    id: 't1',
    site_id: 'w',
    title: 'x',
    source: 'manual',
    due_date: null,
    note_id: null,
  });
});

describe('createTask', () => {
  it('creates + audits an insert', async () => {
    await createTask({ siteId: 'w', title: 'Call MRC', createdBy: 'u1' });
    expect(taskCreate).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'insert', table_name: 'ops_tasks', row_id: 't1' }),
    );
  });
});

describe('transitionTask', () => {
  it('open → done sets completed_at/by and audits', async () => {
    taskFindUnique.mockResolvedValue({ id: 't1', status: 'open' });
    taskUpdate.mockResolvedValue({
      id: 't1',
      status: 'done',
      completed_at: DAY,
      completed_by: 'u1',
    });
    await transitionTask('t1', 'done', 'u1', DAY);
    expect(taskUpdate.mock.calls[0]![0].data).toMatchObject({
      status: 'done',
      completed_at: DAY,
      completed_by: 'u1',
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'update', table_name: 'ops_tasks' }),
    );
  });

  it('done → open clears completion', async () => {
    taskFindUnique.mockResolvedValue({ id: 't1', status: 'done' });
    taskUpdate.mockResolvedValue({
      id: 't1',
      status: 'open',
      completed_at: null,
      completed_by: null,
    });
    await transitionTask('t1', 'open', 'u1');
    expect(taskUpdate.mock.calls[0]![0].data).toMatchObject({
      completed_at: null,
      completed_by: null,
    });
  });

  it('rejects a no-op transition (409) so the audit trail stays meaningful', async () => {
    taskFindUnique.mockResolvedValue({ id: 't1', status: 'done' });
    await expect(transitionTask('t1', 'done', 'u1')).rejects.toBeInstanceOf(OpsTaskError);
    expect(taskUpdate).not.toHaveBeenCalled();
  });

  it('404 on a missing task', async () => {
    taskFindUnique.mockResolvedValue(null);
    await expect(transitionTask('nope', 'done', 'u1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createNoteWithTasks (meeting → action items, one transaction)', () => {
  it('creates the note + N meeting tasks inside a single $transaction', async () => {
    txNoteCreate.mockResolvedValue({ id: 'n1', site_id: 'w', title: 'Standup' });
    txTaskCreate
      .mockResolvedValueOnce({ id: 'ta', site_id: 'w', title: 'A' })
      .mockResolvedValueOnce({ id: 'tb', site_id: 'w', title: 'B' });
    const { note, tasks } = await createNoteWithTasks(
      { siteId: 'w', noteDate: DAY, title: 'Standup', body: 'notes', authorUserId: 'u1' },
      [{ title: 'A' }, { title: 'B' }],
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(note.id).toBe('n1');
    expect(tasks).toHaveLength(2);
    expect(txTaskCreate.mock.calls[0]![0].data).toMatchObject({ source: 'meeting', note_id: 'n1' });
    // 1 note audit + 2 task audits after commit
    expect(writeAudit).toHaveBeenCalledTimes(3);
  });
});

describe('dueSummaryForSite', () => {
  it('splits overdue (due < today) from due-today, and can include org-wide', async () => {
    taskFindMany.mockResolvedValue([
      {
        id: 'o',
        site_id: 'w',
        title: 'Overdue',
        due_date: new Date(Date.UTC(2026, 6, 1)),
        assignee_user_id: null,
      },
      { id: 'd', site_id: null, title: 'DueToday', due_date: DAY, assignee_user_id: null },
    ]);
    const summary = await dueSummaryForSite('w', DAY, true);
    expect(summary.overdue.map((t) => t.id)).toEqual(['o']);
    expect(summary.dueToday.map((t) => t.id)).toEqual(['d']);
    // includeOrgWide → the where uses an OR over site + null
    const where = taskFindMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain('null');
  });

  it('site-only when includeOrgWide is false', async () => {
    taskFindMany.mockResolvedValue([]);
    await dueSummaryForSite('w', DAY, false);
    const where = taskFindMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where.AND[0])).toBe(JSON.stringify({ site_id: 'w' }));
  });
});

describe('assign a task to an admin (2026-07-16)', () => {
  it('listAssignableAdmins queries active admins only', async () => {
    userFindMany.mockResolvedValue([{ id: 'a1', name: 'Bill', email: 'bill@svdp.us' }]);
    const admins = await listAssignableAdmins();
    expect(admins).toHaveLength(1);
    const where = (userFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ role: 'admin', is_active: true, deleted_at: null });
  });

  it('assertAssignableAdmin passes for an active admin', async () => {
    userFindFirst.mockResolvedValue({ id: 'a1' });
    await expect(assertAssignableAdmin('a1')).resolves.toBeUndefined();
  });

  it('assertAssignableAdmin throws 422 for a non-admin / unknown id', async () => {
    userFindFirst.mockResolvedValue(null);
    await expect(assertAssignableAdmin('nope')).rejects.toMatchObject({
      reason: 'assignee_not_an_admin',
      status: 422,
    });
  });

  it('reassignTask validates the admin, updates, and audits before/after', async () => {
    taskFindUnique.mockResolvedValue({ assignee_user_id: null });
    userFindFirst.mockResolvedValue({ id: 'a1' });
    taskUpdate.mockResolvedValue({ id: 't1', assignee_user_id: 'a1' });
    await reassignTask('t1', 'a1', 'u1');
    expect(taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1' }, data: { assignee_user_id: 'a1' } }),
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        table_name: 'ops_tasks',
        before: { assignee_user_id: null },
        after: { assignee_user_id: 'a1' },
      }),
    );
  });

  it('reassignTask to null clears the owner without an admin check', async () => {
    taskFindUnique.mockResolvedValue({ assignee_user_id: 'a1' });
    taskUpdate.mockResolvedValue({ id: 't1', assignee_user_id: null });
    await reassignTask('t1', null, 'u1');
    expect(userFindFirst).not.toHaveBeenCalled();
    expect(taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignee_user_id: null } }),
    );
  });

  it('reassignTask 404s an unknown task with no write', async () => {
    taskFindUnique.mockResolvedValue(null);
    await expect(reassignTask('gone', 'a1', 'u1')).rejects.toBeInstanceOf(OpsTaskError);
    expect(taskUpdate).not.toHaveBeenCalled();
  });
});
