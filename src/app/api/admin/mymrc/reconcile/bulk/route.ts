// ADR-0057 D4 — bulk-approve every actionable item of one class (mirror_table +
// change_kind), e.g. "approve all new_record from mymrc_processed_mirror". Admin-
// only; required note applied to all; each item decided in its own transaction so
// one bad apply fails alone. Only APPROVE is bulk-able (reject/snooze are per-item
// judgments).

import { NextResponse } from 'next/server';
import type { ReconChangeKind } from '@prisma/client';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import {
  assertReconcileNote,
  bulkApproveReconciliations,
  ReconNoteRequiredError,
} from '@/lib/reconcile/apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOTE_MAX_LEN = 2000;
const CHANGE_KINDS: readonly ReconChangeKind[] = ['new_record', 'field_update', 'disappeared'];

interface BulkBody {
  mirror_table?: string;
  change_kind?: string;
  note?: string;
}

export async function POST(req: Request): Promise<Response> {
  let actorUserId: string;
  try {
    actorUserId = (await requireAdmin()).userId;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as BulkBody;
    const mirrorTable = body.mirror_table?.trim();
    const changeKind = body.change_kind?.trim();
    if (!mirrorTable) {
      return NextResponse.json({ error: 'mirror_table is required' }, { status: 400 });
    }
    if (!changeKind || !CHANGE_KINDS.includes(changeKind as ReconChangeKind)) {
      return NextResponse.json({ error: 'valid change_kind is required' }, { status: 400 });
    }
    if (typeof body.note === 'string' && body.note.length > NOTE_MAX_LEN) {
      return NextResponse.json(
        { error: `note must be ${NOTE_MAX_LEN} characters or fewer` },
        { status: 400 },
      );
    }
    // A bulk approve is a decision on many rows — the same required-note gate applies.
    assertReconcileNote('approved', body.note);

    const result = await bulkApproveReconciliations({
      prisma,
      mirrorTable,
      changeKind: changeKind as ReconChangeKind,
      actorUserId,
      note: (body.note as string).trim(),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ReconNoteRequiredError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
