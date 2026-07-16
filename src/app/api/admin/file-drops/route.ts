// O-2 (2026-07-16) — admin file-drop inbox: capture + list.
//
// POST: an admin uploads ANY file (multipart). The bytes are buffered server-side
// and PUT to R2 under `file-drops/<id>/<sanitized-name>` (mirrors the workbook /
// AP server-buffered upload path — the admin uploads from a browser, so there is
// no iPad-style direct-to-edge presign here). One manifest row + one audit row are
// written. R2 is FAIL-SOFT: if unconfigured, the row still records with a
// non-fetchable `pending-r2-filedrop-…` placeholder key so capture never fails.
// Accepts ANY content-type — this is a raw inbox by design (O-2: "I can just dump
// the data there"). Classification/routing is a downstream human step.
//
// GET: the manifest, newest first, with uploaded-by names resolved.
//
// Admin-only (role=admin) per hard rule #2 — matches every other /admin/* surface.

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { putFileDrop } from '@/lib/r2';
import { classifyFileDrop } from '@/lib/file-drop/classify';
import { listFileDrops } from '@/lib/file-drop/list';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 100 MB — a sane ceiling that also sits under Cloudflare's free-plan upload cap,
// so a drop that reaches the origin is one the tunnel would actually pass.
const MAX_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected multipart form' }, { status: 400 });

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'file is empty' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large', maxBytes: MAX_BYTES }, { status: 413 });
  }

  const id = randomUUID();
  const originalFilename = file.name || 'file.bin';
  const contentType = file.type || 'application/octet-stream';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedKind = classifyFileDrop({ filename: originalFilename, contentType });

  // Byte-size from the buffered bytes (authoritative) rather than the declared
  // File.size, so the manifest records what actually landed in R2.
  const byteSize = bytes.byteLength;

  const storedKey = await putFileDrop({ id, filename: originalFilename, contentType, bytes });
  // Fail-soft: R2 unconfigured → a non-fetchable placeholder so capture still records.
  const r2Key = storedKey ?? `pending-r2-filedrop-${id}`;

  const created = await prisma.fileDrop.create({
    data: {
      id,
      original_filename: originalFilename,
      content_type: contentType,
      byte_size: byteSize,
      r2_key: r2Key,
      detected_kind: detectedKind,
      uploaded_by: admin.userId,
    },
  });

  await writeAudit({
    actor_user_id: admin.userId,
    action: 'insert',
    table_name: 'file_drops',
    row_id: created.id,
    after: {
      original_filename: originalFilename,
      content_type: contentType,
      byte_size: byteSize,
      detected_kind: detectedKind,
      r2_stored: storedKey !== null,
    },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent'),
  });

  return NextResponse.json(
    {
      id: created.id,
      detectedKind,
      byteSize,
      downloadable: storedKey !== null,
    },
    { status: 201 },
  );
}

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const rows = await listFileDrops();
  return NextResponse.json({ rows });
}
