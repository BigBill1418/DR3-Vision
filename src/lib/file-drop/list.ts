// O-2 — the file-drop manifest, serialized for the admin surface. Shared by the
// SSR page (initial render) and the GET list route (client refresh) so both emit
// the identical row shape. Resolves `uploaded_by` (a bare user id, no FK) to a
// display name in one batched lookup.

import { prisma } from '@/lib/prisma';

export interface FileDropRow {
  id: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  status: 'received' | 'routed' | 'discarded';
  detectedKind: string | null;
  note: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdISO: string;
  /** false for a `pending-r2-…` placeholder key (R2 was unconfigured at capture). */
  downloadable: boolean;
}

const LIST_LIMIT = 250;

export async function listFileDrops(): Promise<FileDropRow[]> {
  const drops = await prisma.fileDrop.findMany({
    orderBy: { created_at: 'desc' },
    take: LIST_LIMIT,
  });

  const uploaderIds = [...new Set(drops.map((d) => d.uploaded_by))];
  const users = uploaderIds.length
    ? await prisma.user.findMany({
        where: { id: { in: uploaderIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return drops.map((d) => ({
    id: d.id,
    originalFilename: d.original_filename,
    contentType: d.content_type,
    byteSize: d.byte_size,
    status: d.status,
    detectedKind: d.detected_kind,
    note: d.note,
    uploadedBy: d.uploaded_by,
    uploadedByName: nameById.get(d.uploaded_by) ?? 'unknown',
    createdISO: d.created_at.toISOString(),
    downloadable: !d.r2_key.startsWith('pending-r2-'),
  }));
}
