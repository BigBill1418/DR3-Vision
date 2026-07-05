// ADR-0045 D1 — ops notes API (site-scoped). GET lists notes visible to the
// caller on this site (site rows + org-wide when the caller has org reach); POST
// creates a note, optionally with action items (meeting → tasks in one motion).

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { canWriteRow } from '@/lib/ops/reach';
import { createNote, listNotes } from '@/lib/ops/notes';
import { createNoteWithTasks } from '@/lib/ops/tasks';
import { appToday } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ site: string }> };

function dayKeyFromISO(iso: unknown): Date {
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Date(`${iso}T00:00:00.000Z`);
  }
  return appToday();
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const { site } = await ctx.params;
    const mgr = await requireManagerForSite(site);
    const id = await currentOpsViewer();
    const rows = await listNotes(id!.viewer, mgr.siteId);
    return NextResponse.json({ rows });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

interface NoteBody {
  title?: string;
  body?: string;
  note_date?: string;
  org_wide?: boolean;
  action_items?: { title: string; body?: string; due_date?: string }[];
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const { site } = await ctx.params;
    const mgr = await requireManagerForSite(site);
    const id = await currentOpsViewer();
    const body = (await req.json()) as NoteBody;

    if (!body.body || body.body.trim() === '') {
      return NextResponse.json({ error: 'body_required' }, { status: 422 });
    }
    const siteId = body.org_wide === true ? null : mgr.siteId;
    // Org-wide writes require org reach (admin / all_sites).
    if (!canWriteRow(id!.viewer, siteId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const noteDate = dayKeyFromISO(body.note_date);
    const items = (body.action_items ?? []).filter((i) => i.title?.trim());

    if (items.length > 0) {
      const result = await createNoteWithTasks(
        { siteId, noteDate, title: body.title ?? null, body: body.body, authorUserId: id!.userId },
        items.map((i) => ({
          title: i.title,
          body: i.body ?? null,
          dueDate: i.due_date ? dayKeyFromISO(i.due_date) : null,
        })),
      );
      return NextResponse.json({ note: result.note, taskCount: result.tasks.length }, { status: 201 });
    }

    const note = await createNote({
      siteId,
      noteDate,
      title: body.title ?? null,
      body: body.body,
      authorUserId: id!.userId,
    });
    return NextResponse.json({ note }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
