// O-2 — annotate a file-drop (status/note), admin-only + audited. Verifies the
// update writes the mutation + a before/after audit row, rejects a non-admin,
// 404s an unknown id, and 422s an empty patch.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Data = Record<string, unknown>;

let lastUpdate: Data = {};
let lastAudit: Data = {};

const requireAdmin = vi.fn(async () => ({ userId: 'admin-1', email: 'a@x', name: 'Admin' }));
const findUnique = vi.fn(async (): Promise<Data | null> => null);
const update = vi.fn(async (a: { data: Data }): Promise<Data> => {
  lastUpdate = a.data;
  // Echo back the patched fields (the route reselects id/status/note). Computing
  // the return from the input keeps the capturing impl intact — a mockResolvedValue
  // override would replace it and lose the captured `a.data`.
  return {
    id: 'd1',
    status: (a.data['status'] as string | undefined) ?? 'routed',
    note: 'note' in a.data ? a.data['note'] : null,
  };
});
const writeAudit = vi.fn(async (a: Data) => {
  lastAudit = a;
});

vi.mock('@/lib/auth-helpers', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    fileDrop: {
      findUnique: () => findUnique(),
      update: (a: { data: Data }) => update(a),
    },
  },
}));
vi.mock('@/lib/audit', () => ({ writeAudit: (a: Data) => writeAudit(a) }));

import { PATCH } from './route';

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`http://127.0.0.1/api/admin/file-drops/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  lastUpdate = {};
  lastAudit = {};
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue({ userId: 'admin-1', email: 'a@x', name: 'Admin' });
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  update.mockClear();
  writeAudit.mockClear();
});

describe('PATCH /api/admin/file-drops/[id]', () => {
  it('sets status + note, and audits before/after', async () => {
    findUnique.mockResolvedValue({ status: 'received', note: null });

    const res = await patch('d1', { status: 'routed', note: '  imported to equipment  ' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('routed');

    expect(lastUpdate['status']).toBe('routed');
    expect(lastUpdate['note']).toBe('imported to equipment'); // trimmed

    expect(lastAudit['action']).toBe('update');
    expect(lastAudit['table_name']).toBe('file_drops');
    expect(lastAudit['before']).toEqual({ status: 'received', note: null });
    expect(lastAudit['after']).toEqual({ status: 'routed', note: 'imported to equipment' });
  });

  it('clears the note when passed null', async () => {
    findUnique.mockResolvedValue({ status: 'routed', note: 'x' });
    const res = await patch('d1', { note: null });
    expect(res.status).toBe(200);
    expect(lastUpdate).toEqual({ note: null });
  });

  it('rejects a non-admin (403)', async () => {
    requireAdmin.mockRejectedValueOnce(new Response('forbidden', { status: 403 }));
    expect((await patch('d1', { status: 'routed' })).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('404s an unknown id', async () => {
    findUnique.mockResolvedValue(null);
    expect((await patch('nope', { status: 'routed' })).status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('422s an empty patch (nothing to update)', async () => {
    expect((await patch('d1', {})).status).toBe(422);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('422s an invalid status', async () => {
    expect((await patch('d1', { status: 'bogus' })).status).toBe(422);
  });
});
