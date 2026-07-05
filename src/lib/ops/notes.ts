// ADR-0045 D1 — ops notes service (the meeting/ops-note ledger).
//
// Notes are site-scoped or org-wide (site_id NULL); reach is enforced by the
// `reachWhere` filter (hard rule #2). Every mutation is audited on `ops_notes`.
// A note can spawn tasks in one motion — see `createNoteWithTasks` in tasks.ts,
// which owns the meeting → action-items transaction.

import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { reachWhere, type OpsViewer } from './reach';

export interface CreateNoteInput {
  siteId: string | null;
  noteDate: Date; // @db.Date-shaped
  title?: string | null;
  body: string;
  authorUserId: string;
}

export async function createNote(input: CreateNoteInput) {
  const note = await prisma.opsNote.create({
    data: {
      site_id: input.siteId,
      note_date: input.noteDate,
      title: input.title ?? null,
      body: input.body,
      author_user_id: input.authorUserId,
    },
  });
  await writeAudit({
    actor_user_id: input.authorUserId,
    action: 'insert',
    table_name: 'ops_notes',
    row_id: note.id,
    after: { site_id: note.site_id, note_date: note.note_date, title: note.title },
  });
  return note;
}

export interface UpdateNoteInput {
  title?: string | null;
  body?: string;
  noteDate?: Date;
}

/** Edit an existing note. The caller must have already passed reach for the row. */
export async function updateNote(id: string, input: UpdateNoteInput, actorUserId: string) {
  const before = await prisma.opsNote.findUnique({ where: { id } });
  if (!before) throw new OpsNoteError('not_found', 404);
  const note = await prisma.opsNote.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.noteDate !== undefined ? { note_date: input.noteDate } : {}),
    },
  });
  await writeAudit({
    actor_user_id: actorUserId,
    action: 'update',
    table_name: 'ops_notes',
    row_id: id,
    before: { title: before.title, body: before.body, note_date: before.note_date },
    after: { title: note.title, body: note.body, note_date: note.note_date },
  });
  return note;
}

/** List notes visible to `viewer` on the given site page (site rows + org-wide). */
export function listNotes(viewer: OpsViewer, siteId: string) {
  return prisma.opsNote.findMany({
    where: reachWhere(viewer, siteId),
    orderBy: [{ note_date: 'desc' }, { created_at: 'desc' }],
    include: { tasks: { select: { id: true, title: true, status: true, due_date: true } } },
  });
}

export class OpsNoteError extends Error {
  constructor(
    public reason: string,
    public status: 404 | 403,
  ) {
    super(reason);
    this.name = 'OpsNoteError';
  }
}
