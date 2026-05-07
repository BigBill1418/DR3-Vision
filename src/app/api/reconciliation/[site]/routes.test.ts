// Sprint-1 T-016 — route-level tests covering the auth gate, the
// happy upload path, the idempotency surface (duplicate sha256 ->
// 200 + created:false), and the cross-site rejection that hard
// rule #2 demands.
//
// In-process Prisma + auth mocks (same shape as
// admin-users.test.ts) so the suite runs on the vitest `node` env
// without a live database. We test through the real route handlers,
// not the underlying lib, so the coverage includes the multipart
// parsing + the `requireManagerForSite` gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession:
  | { user: { id: string; role: string; primary_site_id?: string | null } }
  | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

interface MockSite {
  id: string;
  code: string;
  name: string;
}
interface MockReconciliation {
  id: string;
  site_id: string;
  filename: string;
  content_sha256: string;
}
interface MockItem {
  id: string;
  reconciliation_id: string;
  external_haul_id: string;
  status: string;
  resolution: string;
  resolution_notes: string | null;
  resolved_at: Date | null;
  resolved_by_id: string | null;
}

const sites = new Map<string, MockSite>();
const recs = new Map<string, MockReconciliation>();
const items = new Map<string, MockItem>();
const audit: Array<{ action: string; row_id: string; table_name: string }> = [];
let counter = 1;

function reset() {
  sites.clear();
  recs.clear();
  items.clear();
  audit.length = 0;
  counter = 1;
  sites.set('site-eugene', { id: 'site-eugene', code: 'eugene', name: 'Eugene' });
  sites.set('site-woodland', { id: 'site-woodland', code: 'woodland', name: 'Woodland' });
}

vi.mock('@/lib/prisma', () => {
  const site = {
    findUnique: vi.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
      if (where.code) {
        for (const s of sites.values()) if (s.code === where.code) return s;
        return null;
      }
      if (where.id) return sites.get(where.id) ?? null;
      return null;
    }),
  };
  const inboundLoad = {
    findMany: vi.fn(async () => [
      // Seed two DR3 loads with known haul IDs that the
      // happy-path fixture references.
      {
        id: 'L-1',
        external_mymrc_haul_id: 'H-1',
        total_units: 50,
        weight_lbs: 5000,
      },
      {
        id: 'L-2',
        external_mymrc_haul_id: 'H-2',
        total_units: 60,
        weight_lbs: 6000,
      },
    ]),
  };
  const mymrcReconciliation = {
    findUnique: vi.fn(async ({ where }: { where: unknown }) => {
      const w = where as
        | { id: string }
        | { site_id_content_sha256: { site_id: string; content_sha256: string } };
      if ('id' in w) return recs.get(w.id) ?? null;
      for (const r of recs.values()) {
        if (
          r.site_id === w.site_id_content_sha256.site_id &&
          r.content_sha256 === w.site_id_content_sha256.content_sha256
        )
          return r;
      }
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      // Enforce uniqueness on (site_id, content_sha256).
      for (const ex of recs.values()) {
        if (ex.site_id === data['site_id'] && ex.content_sha256 === data['content_sha256']) {
          const violation = Object.assign(new Error('unique violation'), { code: 'P2002' });
          throw violation;
        }
      }
      const id = `rec-${counter++}`;
      const r: MockReconciliation = {
        id,
        site_id: data['site_id'] as string,
        filename: data['filename'] as string,
        content_sha256: data['content_sha256'] as string,
      };
      recs.set(id, r);
      return { ...r, weight_tolerance_pct: { toString: () => '2.00' } };
    }),
    update: vi.fn(async ({ where }: { where: { id: string } }) => recs.get(where.id) ?? null),
  };
  const mymrcReconciliationItem = {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const d of data) {
        const id = `it-${counter++}`;
        items.set(id, {
          id,
          reconciliation_id: d['reconciliation_id'] as string,
          external_haul_id: d['external_haul_id'] as string,
          status: d['status'] as string,
          resolution: 'unresolved',
          resolution_notes: null,
          resolved_at: null,
          resolved_by_id: null,
        });
      }
      return { count: data.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const it = items.get(where.id);
      if (!it) return null;
      const rec = recs.get(it.reconciliation_id);
      return { ...it, reconciliation: rec ? { site_id: rec.site_id } : null };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const it = items.get(where.id);
        if (!it) throw new Error('not found');
        if ('resolution' in data) it.resolution = data['resolution'] as string;
        if ('resolution_notes' in data)
          it.resolution_notes = data['resolution_notes'] as string | null;
        if ('resolved_at' in data) it.resolved_at = data['resolved_at'] as Date | null;
        if ('resolved_by_id' in data) it.resolved_by_id = data['resolved_by_id'] as string | null;
        return it;
      }
    ),
  };
  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audit.push({
        action: data['action'] as string,
        row_id: data['row_id'] as string,
        table_name: data['table_name'] as string,
      });
      return { id: `audit-${audit.length}` };
    }),
  };

  return {
    prisma: {
      site,
      inboundLoad,
      mymrcReconciliation,
      mymrcReconciliationItem,
      auditLog,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ mymrcReconciliation, mymrcReconciliationItem, auditLog })
      ),
    },
  };
});

vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  class FakeKnown extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: FakeKnown,
    },
  };
});

beforeEach(() => {
  reset();
});

// ── Helpers ─────────────────────────────────────────────────────

const HEADER =
  'Recycler,Haul: Haul ID,Recycler Reported Delivery Date,Collection Site,Unit Count at Unload,Transporter,Recycler Weight';

function csvBody(rows: ReadonlyArray<readonly string[]>): string {
  return [HEADER, ...rows.map((r) => r.join(','))].join('\n');
}

function multipartReq(
  url: string,
  csvText: string,
  filename = 'march.csv',
  tolerance = '2.0'
): Request {
  const fd = new FormData();
  fd.append('file', new File([csvText], filename, { type: 'text/csv' }));
  fd.append('tolerance_pct', tolerance);
  return new Request(url, { method: 'POST', body: fd });
}

// ── Tests ───────────────────────────────────────────────────────

describe('POST /api/reconciliation/[site]/upload — auth gate', () => {
  it('401 when unauthenticated', async () => {
    const { POST } = await import('./upload/route');
    mockSession = null;
    const res = await POST(
      multipartReq('http://x/api/reconciliation/eugene/upload', csvBody([])),
      { params: Promise.resolve({ site: 'eugene' }) }
    );
    expect(res.status).toBe(401);
  });

  it('403 when manager scoped to a different site (cross-site upload blocked)', async () => {
    const { POST } = await import('./upload/route');
    mockSession = { user: { id: 'mgr-1', role: 'manager', primary_site_id: 'site-eugene' } };
    const text = csvBody([['DR3 Woodland', 'H-1', '03/15/2026', 'A', '50', 'C', '5000']]);
    const res = await POST(
      multipartReq('http://x/api/reconciliation/woodland/upload', text),
      { params: Promise.resolve({ site: 'woodland' }) }
    );
    expect(res.status).toBe(403);
  });

  it('201 happy path for the same-site manager', async () => {
    const { POST } = await import('./upload/route');
    mockSession = { user: { id: 'mgr-1', role: 'manager', primary_site_id: 'site-eugene' } };
    const text = csvBody([
      ['DR3 Eugene', 'H-1', '03/15/2026', 'A', '50', 'C', '5000'],
      ['DR3 Eugene', 'H-2', '03/16/2026', 'A', '60', 'C', '6000'],
    ]);
    const res = await POST(multipartReq('http://x/api/reconciliation/eugene/upload', text), {
      params: Promise.resolve({ site: 'eugene' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; counts: Record<string, number> };
    expect(body.created).toBe(true);
    expect(body.counts['match_clean']).toBe(2);
  });

  it('admin can upload to any site', async () => {
    const { POST } = await import('./upload/route');
    mockSession = { user: { id: 'admin-1', role: 'admin', primary_site_id: 'site-eugene' } };
    const text = csvBody([['DR3 Woodland', 'H-1', '03/15/2026', 'A', '50', 'C', '5000']]);
    const res = await POST(
      multipartReq('http://x/api/reconciliation/woodland/upload', text),
      { params: Promise.resolve({ site: 'woodland' }) }
    );
    expect(res.status).toBe(201);
  });
});

describe('POST /api/reconciliation/[site]/upload — validation', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'mgr-1', role: 'manager', primary_site_id: 'site-eugene' } };
  });

  it('422 when required CSV columns are missing', async () => {
    const { POST } = await import('./upload/route');
    const res = await POST(
      multipartReq(
        'http://x/api/reconciliation/eugene/upload',
        'Recycler,Haul: Haul ID\nDR3 Eugene,H-1'
      ),
      { params: Promise.resolve({ site: 'eugene' }) }
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_columns');
  });

  it('400 when no file part is present in the multipart body', async () => {
    const { POST } = await import('./upload/route');
    const fd = new FormData();
    fd.append('tolerance_pct', '2.0');
    const res = await POST(
      new Request('http://x/api/reconciliation/eugene/upload', {
        method: 'POST',
        body: fd,
      }),
      { params: Promise.resolve({ site: 'eugene' }) }
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/reconciliation/[site]/upload — idempotency', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'mgr-1', role: 'manager', primary_site_id: 'site-eugene' } };
  });

  it('returns 200 + created:false on byte-identical re-upload', async () => {
    const { POST } = await import('./upload/route');
    const text = csvBody([['DR3 Eugene', 'H-1', '03/15/2026', 'A', '50', 'C', '5000']]);

    const first = await POST(multipartReq('http://x/api/reconciliation/eugene/upload', text), {
      params: Promise.resolve({ site: 'eugene' }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { reconciliation_id: string; created: boolean };
    expect(firstBody.created).toBe(true);

    const second = await POST(
      multipartReq('http://x/api/reconciliation/eugene/upload', text, 'march-renamed.csv'),
      { params: Promise.resolve({ site: 'eugene' }) }
    );
    expect(second['status']).toBe(200);
    const secondBody = (await second.json()) as { reconciliation_id: string; created: boolean };
    expect(secondBody.created).toBe(false);
    expect(secondBody.reconciliation_id).toBe(firstBody.reconciliation_id);
    // No duplicate items, no second audit row.
    expect(recs.size).toBe(1);
    expect(audit.filter((a) => a.table_name === 'mymrc_reconciliations').length).toBe(1);
  });
});

describe('POST /api/reconciliation/[site]/items/[itemId]/resolve', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'mgr-1', role: 'manager', primary_site_id: 'site-eugene' } };
  });

  async function seedOne() {
    const { POST: uploadPOST } = await import('./upload/route');
    const text = csvBody([['DR3 Eugene', 'H-1', '03/15/2026', 'A', '50', 'C', '5000']]);
    await uploadPOST(multipartReq('http://x/api/reconciliation/eugene/upload', text), {
      params: Promise.resolve({ site: 'eugene' }),
    });
    return Array.from(items.values())[0]!;
  }

  it('writes one item update + one audit row per click', async () => {
    const item = await seedOne();
    audit.length = 0;
    const { POST } = await import('./items/[itemId]/resolve/route');
    const res = await POST(
      new Request(`http://x/api/reconciliation/eugene/items/${item.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution: 'dr3_correct', notes: 'looks right' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ site: 'eugene', itemId: item.id }) }
    );
    expect(res.status).toBe(200);
    const updates = audit.filter(
      (a) => a.action === 'update' && a.table_name === 'mymrc_reconciliation_items'
    );
    expect(updates.length).toBe(1);
    const after = items.get(item.id)!;
    expect(after.resolution).toBe('dr3_correct');
    expect(after.resolution_notes).toBe('looks right');
  });

  it('refuses to resolve a Woodland item from a Eugene-scoped manager URL', async () => {
    // Seed under Eugene first
    const item = await seedOne();
    // Switch manager to Woodland and try to hit the item via woodland URL
    mockSession = {
      user: { id: 'mgr-2', role: 'manager', primary_site_id: 'site-woodland' },
    };
    const { POST } = await import('./items/[itemId]/resolve/route');
    const res = await POST(
      new Request(`http://x/api/reconciliation/woodland/items/${item.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution: 'dr3_correct' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ site: 'woodland', itemId: item.id }) }
    );
    // 404 — we don't reveal that the item exists at another site.
    expect(res.status).toBe(404);
  });

  it('rejects an invalid resolution value with 422', async () => {
    const item = await seedOne();
    const { POST } = await import('./items/[itemId]/resolve/route');
    const res = await POST(
      new Request(`http://x/api/reconciliation/eugene/items/${item.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution: 'whatever' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ site: 'eugene', itemId: item.id }) }
    );
    expect(res.status).toBe(422);
  });
});
