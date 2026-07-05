import { beforeEach, describe, expect, it, vi } from 'vitest';

const noteCreate = vi.fn();
const noteUpdate = vi.fn();
const noteFindUnique = vi.fn();
const noteFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    opsNote: {
      create: (...a: unknown[]) => noteCreate(...a),
      update: (...a: unknown[]) => noteUpdate(...a),
      findUnique: (...a: unknown[]) => noteFindUnique(...a),
      findMany: (...a: unknown[]) => noteFindMany(...a),
    },
  },
}));

const writeAudit = vi.fn();
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

import { createNote, listNotes, updateNote } from './notes';
import type { OpsViewer } from './reach';

const DAY = new Date(Date.UTC(2026, 6, 6));

beforeEach(() => vi.clearAllMocks());

describe('createNote', () => {
  it('creates + audits, org-wide when siteId null', async () => {
    noteCreate.mockResolvedValue({ id: 'n1', site_id: null, note_date: DAY, title: null });
    await createNote({ siteId: null, noteDate: DAY, body: 'org note', authorUserId: 'u1' });
    expect(noteCreate.mock.calls[0]![0].data).toMatchObject({ site_id: null, body: 'org note' });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'insert', table_name: 'ops_notes', row_id: 'n1' }),
    );
  });
});

describe('updateNote', () => {
  it('404 when the note is missing', async () => {
    noteFindUnique.mockResolvedValue(null);
    await expect(updateNote('x', { body: 'y' }, 'u1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('listNotes reach', () => {
  it('a plain manager sees only their site (no org-wide clause)', async () => {
    noteFindMany.mockResolvedValue([]);
    const mgr: OpsViewer = { role: 'manager', primarySiteId: 'w', allSites: false };
    await listNotes(mgr, 'w');
    expect(noteFindMany.mock.calls[0]![0].where).toEqual({ OR: [{ site_id: 'w' }] });
  });
  it('an admin also sees org-wide rows', async () => {
    noteFindMany.mockResolvedValue([]);
    const admin: OpsViewer = { role: 'admin', primarySiteId: null, allSites: false };
    await listNotes(admin, 'w');
    expect(noteFindMany.mock.calls[0]![0].where).toEqual({ OR: [{ site_id: 'w' }, { site_id: null }] });
  });
});
