// O-2 — file-drop capture + list route. Verifies: an admin upload writes ONE
// manifest row + ONE audit row and PUTs to R2 (with the classified hint); a
// non-admin is rejected before any write; empty/missing/oversize files are
// refused; and GET returns the manifest behind the same admin gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Data = Record<string, unknown>;

let lastCreate: Data = {};
let lastAudit: Data = {};

const requireAdmin = vi.fn(async () => ({ userId: 'admin-1', email: 'a@x', name: 'Admin' }));
const create = vi.fn(async (args: { data: Data }) => {
  lastCreate = args.data;
  return { id: args.data['id'] };
});
const writeAudit = vi.fn(async (a: Data) => {
  lastAudit = a;
});
const putFileDrop = vi.fn(
  async (a: { filename: string }): Promise<string | null> => `file-drops/id/${a.filename}`,
);
const listFileDrops = vi.fn(async () => [{ id: 'd1' }]);

vi.mock('@/lib/auth-helpers', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('@/lib/prisma', () => ({
  prisma: { fileDrop: { create: (a: { data: Data }) => create(a) } },
}));
vi.mock('@/lib/audit', () => ({ writeAudit: (a: Data) => writeAudit(a) }));
vi.mock('@/lib/r2', () => ({ putFileDrop: (a: { filename: string }) => putFileDrop(a) }));
vi.mock('@/lib/file-drop/list', () => ({ listFileDrops: () => listFileDrops() }));

import { POST, GET } from './route';

const MAX_BYTES = 100 * 1024 * 1024;

function postWith(file: File | null): Promise<Response> {
  const fd = new FormData();
  if (file) fd.append('file', file);
  return POST(new Request('http://127.0.0.1/api/admin/file-drops', { method: 'POST', body: fd }));
}

beforeEach(() => {
  lastCreate = {};
  lastAudit = {};
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue({ userId: 'admin-1', email: 'a@x', name: 'Admin' });
  create.mockClear();
  writeAudit.mockClear();
  putFileDrop.mockClear();
  putFileDrop.mockResolvedValue('file-drops/id/x');
  listFileDrops.mockClear();
});

describe('POST /api/admin/file-drops', () => {
  it('captures a file: PUTs to R2, writes the row + audit, returns 201 with the hint', async () => {
    const res = await postWith(new File(['a,b,c\n1,2,3\n'], 'export.csv', { type: 'text/csv' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.detectedKind).toBe('csv');
    expect(body.downloadable).toBe(true);

    expect(putFileDrop).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(lastCreate['original_filename']).toBe('export.csv');
    expect(lastCreate['content_type']).toBe('text/csv');
    expect(lastCreate['detected_kind']).toBe('csv');
    expect(lastCreate['uploaded_by']).toBe('admin-1');
    expect(lastCreate['r2_key']).toBe('file-drops/id/x');

    expect(writeAudit).toHaveBeenCalledOnce();
    expect(lastAudit['action']).toBe('insert');
    expect(lastAudit['table_name']).toBe('file_drops');
  });

  it('records a placeholder key (still writes the row) when R2 is unconfigured', async () => {
    putFileDrop.mockResolvedValueOnce(null);
    const res = await postWith(new File(['x'], 'note.txt', { type: 'text/plain' }));
    expect(res.status).toBe(201);
    expect((await res.json()).downloadable).toBe(false);
    expect(String(lastCreate['r2_key'])).toMatch(/^pending-r2-filedrop-/);
    expect(lastCreate['detected_kind']).toBe('other');
  });

  it('rejects a non-admin BEFORE any write (403)', async () => {
    requireAdmin.mockRejectedValueOnce(new Response('forbidden', { status: 403 }));
    const res = await postWith(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(res.status).toBe(403);
    expect(putFileDrop).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('400s a missing file', async () => {
    expect((await postWith(null)).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('400s an empty file', async () => {
    expect((await postWith(new File([], 'empty.bin'))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('413s a file over the 100 MB ceiling (before reading the bytes)', async () => {
    // Pass the File straight through a fake request (no FormData serialization —
    // that round-trip re-derives `size` from content and drops the override, and
    // allocating a real 100 MB buffer just to test a size guard is wasteful).
    const big = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(big, 'size', { value: MAX_BYTES + 1 });
    const fd = new FormData();
    fd.set('file', big);
    const req = { formData: async () => fd, headers: new Headers() } as unknown as Request;
    expect((await POST(req)).status).toBe(413);
    expect(putFileDrop).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/file-drops', () => {
  it('returns the manifest for an admin', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toEqual([{ id: 'd1' }]);
    expect(listFileDrops).toHaveBeenCalledOnce();
  });

  it('rejects a non-admin (403) and never queries the manifest', async () => {
    requireAdmin.mockRejectedValueOnce(new Response('forbidden', { status: 403 }));
    expect((await GET()).status).toBe(403);
    expect(listFileDrops).not.toHaveBeenCalled();
  });
});
