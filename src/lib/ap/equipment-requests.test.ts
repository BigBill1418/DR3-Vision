// ADR-0046 Amendment 9 (§2.2–§2.5) — the equipment escape-hatch data layer.
//
// Stands the module up against an in-memory Prisma stand-in. What these lock down:
//   - the hatch writes the request AND its link in the SAME transaction, with the
//     exactly-one-disposition invariant intact (the DB CHECK is proven separately
//     against real Postgres — see the Amendment 9 verification note in ADR-0046 —
//     but the app must never even ATTEMPT a violating row)
//   - SITE REACH scoping on the worklist + the badge count (hard rule #2). An
//     empty reach must return NOTHING, never everything
//   - resolve is atomic: asset + stamp + backfill, or none of them
//   - the BACKFILL moves both link columns together, because moving one would
//     trip the CHECK in production while passing any test that only asserts
//     `equipment_id`
//   - reject REQUIRES a note, and never touches the invoice
//   - an audit row lands for every mutation, inside the mutation's transaction
//   - recipients resolve from the GRANT (site-scoped), not from a hardcoded list,
//     and never resolve to nobody

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory stores ────────────────────────────────────────────

interface Req {
  id: string;
  ap_request_id: string;
  site_id: string;
  description: string;
  requested_by: string;
  requested_at: Date;
  status: 'open' | 'resolved' | 'rejected';
  resolved_equipment_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
}
interface Link {
  id: string;
  request_id: string;
  equipment_id: string | null;
  is_not_equipment_related: boolean;
  equipment_request_id: string | null;
}
interface Equip {
  id: string;
  site_id: string;
  display_name: string;
  category: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}
interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  all_sites: boolean;
  primary_site_id: string | null;
  deleted_at: Date | null;
  can_resolve_equipment_requests: boolean;
}
interface AuditRow {
  action: string;
  table_name: string;
  row_id: string;
  after: unknown;
  /** True when written through a transaction client (not the bare prisma). */
  inTx: boolean;
}

const EUGENE = 'site-eugene';
const WOODLAND = 'site-woodland';

const reqs = new Map<string, Req>();
const links: Link[] = [];
const equipment = new Map<string, Equip>();
const users = new Map<string, UserRow>();
const audits: AuditRow[] = [];
let seq = 0;
/** Injected failure: the resolve stamp throws, to prove atomicity. */
let stampThrows = false;

function addUser(u: Partial<UserRow> & { id: string; name: string }): void {
  users.set(u.id, {
    email: u.email ?? `${u.id}@svdp.us`,
    role: u.role ?? 'manager',
    all_sites: u.all_sites ?? false,
    primary_site_id: u.primary_site_id ?? null,
    deleted_at: u.deleted_at ?? null,
    can_resolve_equipment_requests: u.can_resolve_equipment_requests ?? false,
    ...u,
  } as UserRow);
}

function reset(): void {
  reqs.clear();
  links.length = 0;
  equipment.clear();
  users.clear();
  audits.length = 0;
  seq = 0;
  stampThrows = false;
  addUser({
    id: 'u-morena',
    name: 'Morena Gomez',
    primary_site_id: WOODLAND,
    can_resolve_equipment_requests: true,
  });
  addUser({
    id: 'u-rick',
    name: 'Rick Albritton',
    primary_site_id: EUGENE,
    can_resolve_equipment_requests: true,
  });
  addUser({ id: 'u-patrick', name: 'Patrick Dills', primary_site_id: EUGENE });
  addUser({ id: 'u-bill', name: 'Bill Barnard', role: 'admin' });
  addUser({ id: 'u-approver', name: 'Kelsey Ruhland', primary_site_id: EUGENE, all_sites: true });
}

/** The one guard the DB CHECK enforces — asserted on every synthetic link write. */
function assertExactlyOneDisposition(l: Link): void {
  const set =
    (l.equipment_id ? 1 : 0) +
    (l.is_not_equipment_related ? 1 : 0) +
    (l.equipment_request_id ? 1 : 0);
  if (set !== 1) {
    throw new Error(
      `ap_equipment_links_exactly_one_disposition violated (${set} dispositions set): ${JSON.stringify(l)}`,
    );
  }
}

// ── Prisma stand-in ─────────────────────────────────────────────

function client(inTx: boolean) {
  return {
    apEquipmentRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Req = {
          id: `req-${++seq}`,
          ap_request_id: data['ap_request_id'] as string,
          site_id: data['site_id'] as string,
          description: data['description'] as string,
          requested_by: data['requested_by'] as string,
          requested_at: new Date('2026-07-28T18:00:00Z'),
          status: (data['status'] as Req['status']) ?? 'open',
          resolved_equipment_id: null,
          resolved_by: null,
          resolved_at: null,
          resolution_note: null,
        };
        reqs.set(row.id, row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = reqs.get(where.id);
        return r ? { ...r } : null;
      }),
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return rowsMatching(where).map((r) => ({
          ...r,
          ap_request: {
            id: r.ap_request_id,
            subject: 'Invoice 123',
            vendor_freeform: 'Acme Rentals',
            confirmed_amount_cents: 45_000,
          },
          resolved_equipment: r.resolved_equipment_id
            ? {
                id: r.resolved_equipment_id,
                display_name: equipment.get(r.resolved_equipment_id)?.display_name ?? '',
              }
            : null,
          links: links
            .filter((l) => l.equipment_request_id === r.id)
            .map((l) => ({ id: l.id, equipment_request_id: l.equipment_request_id })),
        }));
      }),
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return rowsMatching(where).length;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string };
          data: Record<string, unknown>;
        }) => {
          if (stampThrows) throw new Error('injected stamp failure');
          const r = reqs.get(where.id);
          if (!r || (where.status && r.status !== where.status)) return { count: 0 };
          Object.assign(r, data);
          return { count: 1 };
        },
      ),
    },
    apEquipmentLink: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const l: Link = {
          id: `link-${++seq}`,
          request_id: data['request_id'] as string,
          equipment_id: (data['equipment_id'] as string) ?? null,
          is_not_equipment_related: (data['is_not_equipment_related'] as boolean) ?? false,
          equipment_request_id: (data['equipment_request_id'] as string) ?? null,
        };
        assertExactlyOneDisposition(l);
        links.push(l);
        return l;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { equipment_request_id: string };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const l of links) {
            if (l.equipment_request_id !== where.equipment_request_id) continue;
            const next: Link = { ...l, ...(data as Partial<Link>) };
            assertExactlyOneDisposition(next);
            Object.assign(l, next);
            count += 1;
          }
          return { count };
        },
      ),
    },
    equipment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Equip = {
          id: `eq-${++seq}`,
          site_id: data['site_id'] as string,
          display_name: data['display_name'] as string,
          category: data['category'] as string,
          is_active: (data['is_active'] as boolean) ?? true,
          created_at: new Date('2026-07-29T00:00:00Z'),
          updated_at: new Date('2026-07-29T00:00:00Z'),
        };
        equipment.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const e of equipment.values()) {
          if (e.site_id === where['site_id'] && e.display_name === where['display_name']) return e;
        }
        return null;
      }),
    },
    site: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === EUGENE || where.id === WOODLAND ? { id: where.id } : null,
      ),
      findMany: vi.fn(async () => [
        { id: EUGENE, code: 'eugene', name: 'DR3 Eugene' },
        { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' },
      ]),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return Array.from(users.values())
          .filter((u) => matchUser(u, where ?? {}))
          .map((u) => ({ id: u.id, name: u.name, email: u.email }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push({
          action: data['action'] as string,
          table_name: data['table_name'] as string,
          row_id: data['row_id'] as string,
          after: data['after'],
          inTx,
        });
      }),
    },
  };
}

function rowsMatching(where: Record<string, unknown> | undefined): Req[] {
  return Array.from(reqs.values())
    .filter((r) => {
      if (!where) return true;
      if (where['status'] && r.status !== where['status']) return false;
      const site = where['site_id'] as { in?: string[] } | undefined;
      if (site?.in && !site.in.includes(r.site_id)) return false;
      return true;
    })
    .sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime());
}

function matchUser(u: UserRow, where: Record<string, unknown>): boolean {
  if ('deleted_at' in where && u.deleted_at !== where['deleted_at']) return false;
  if (where['role'] && u.role !== where['role']) return false;
  if (where['can_resolve_equipment_requests'] === true && !u.can_resolve_equipment_requests)
    return false;
  if (where['email'] && !u.email) return false;
  const or = where['OR'] as Array<Record<string, unknown>> | undefined;
  if (or) {
    const ok = or.some((clause) => {
      if ('primary_site_id' in clause) return u.primary_site_id === clause['primary_site_id'];
      if ('all_sites' in clause) return u.all_sites === clause['all_sites'];
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

const fakePrisma = {
  ...client(false),
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    // A REAL rollback is what makes the atomicity assertions meaningful, so the
    // stand-in snapshots every store and restores on throw.
    const snapshot = {
      reqs: new Map(Array.from(reqs, ([k, v]) => [k, { ...v }])),
      links: links.map((l) => ({ ...l })),
      equipment: new Map(Array.from(equipment, ([k, v]) => [k, { ...v }])),
      audits: audits.length,
    };
    try {
      return await fn(client(true));
    } catch (e) {
      reqs.clear();
      for (const [k, v] of snapshot.reqs) reqs.set(k, v);
      links.length = 0;
      links.push(...snapshot.links);
      equipment.clear();
      for (const [k, v] of snapshot.equipment) equipment.set(k, v);
      audits.length = snapshot.audits;
      throw e;
    }
  }),
};

// `vi.mock` is hoisted above every top-level const, so the factory cannot close
// over `fakePrisma` directly. A Proxy defers every property read to call time,
// which is the only moment the modules under test actually touch the client.
const holder = vi.hoisted(() => ({ current: null as unknown as Record<string, unknown> }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => holder.current[prop],
  }),
}));
holder.current = fakePrisma as unknown as Record<string, unknown>;

import {
  ApEquipmentRequestError,
  createEquipmentRequestInTx,
  equipmentRequestRecipients,
  listEquipmentRequests,
  openEquipmentRequestCount,
  rejectEquipmentRequest,
  resolveEquipmentRequest,
} from './equipment-requests';

type P = Parameters<typeof listEquipmentRequests>[0];
const db = fakePrisma as unknown as NonNullable<P>;
const actor = { actorUserId: 'u-morena', ip: '10.0.0.1', userAgent: 'vitest' };

/** File a request the way `decideRequest` does — inside a transaction. */
async function fileRequest(opts: { siteId?: string; description?: string } = {}): Promise<string> {
  return fakePrisma.$transaction(async (tx) =>
    createEquipmentRequestInTx(tx as never, {
      apRequestId: 'ap-1',
      siteId: opts.siteId ?? WOODLAND,
      description: opts.description ?? 'Yellow Hyster forklift, unit 7, Woodland',
      requestedBy: 'u-approver',
    }),
  ) as Promise<string>;
}

beforeEach(reset);

// ── §2.2/§2.3 — filing ──────────────────────────────────────────

describe('createEquipmentRequestInTx', () => {
  it('writes the request AND a link pointing at it, with exactly one disposition', async () => {
    const id = await fileRequest();
    expect(reqs.get(id)?.status).toBe('open');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      equipment_request_id: id,
      equipment_id: null,
      is_not_equipment_related: false,
    });
    // assertExactlyOneDisposition ran inside create — a violating row would have
    // thrown before reaching here.
  });

  it('refuses a blank description — the hatch is never a free pass', async () => {
    await expect(fileRequest({ description: '   ' })).rejects.toBeInstanceOf(
      ApEquipmentRequestError,
    );
    expect(reqs.size).toBe(0);
    expect(links).toHaveLength(0);
  });

  it('audits the filing inside the caller transaction', async () => {
    const id = await fileRequest();
    const row = audits.find((a) => a.table_name === 'ap_equipment_requests' && a.row_id === id);
    expect(row?.action).toBe('insert');
    expect(row?.inTx).toBe(true);
  });
});

// ── §2.5 — reads + hard rule #2 scoping ─────────────────────────

describe('listEquipmentRequests / openEquipmentRequestCount — site reach', () => {
  beforeEach(async () => {
    await fileRequest({ siteId: WOODLAND, description: 'Woodland forklift' });
    await fileRequest({ siteId: EUGENE, description: 'Eugene baler' });
  });

  it('undefined reach (admin / all_sites) sees both sites', async () => {
    expect(await listEquipmentRequests(db)).toHaveLength(2);
    expect(await openEquipmentRequestCount(db)).toBe(2);
  });

  it('a single-site manager sees only their own site', async () => {
    const rows = await listEquipmentRequests(db, { siteIds: [WOODLAND] });
    expect(rows.map((r) => r.description)).toEqual(['Woodland forklift']);
    expect(await openEquipmentRequestCount(db, { siteIds: [WOODLAND] })).toBe(1);
  });

  it('an EMPTY reach returns nothing — never everything', async () => {
    expect(await listEquipmentRequests(db, { siteIds: [] })).toHaveLength(0);
    expect(await openEquipmentRequestCount(db, { siteIds: [] })).toBe(0);
  });

  it('carries the invoice context and the requester name', async () => {
    const [row] = await listEquipmentRequests(db, { siteIds: [WOODLAND] });
    expect(row).toMatchObject({
      vendor: 'Acme Rentals',
      amountCents: 45_000,
      requesterName: 'Kelsey Ruhland',
      siteCode: 'woodland',
      linkPending: true,
    });
  });
});

// ── §2.5 — resolve + backfill ───────────────────────────────────

describe('resolveEquipmentRequest', () => {
  it('creates the asset, stamps the request, and backfills the original link', async () => {
    const id = await fileRequest();
    const res = await resolveEquipmentRequest(
      db,
      id,
      { displayName: 'F07 — Hyster Forklift', category: 'forklift' },
      actor,
    );

    expect(res.backfilledLinks).toBe(1);
    const created = equipment.get(res.equipmentId);
    expect(created).toMatchObject({ display_name: 'F07 — Hyster Forklift', site_id: WOODLAND });

    const row = reqs.get(id);
    expect(row).toMatchObject({
      status: 'resolved',
      resolved_equipment_id: res.equipmentId,
      resolved_by: 'u-morena',
    });
    expect(row?.resolved_at).toBeInstanceOf(Date);

    // BOTH link columns moved together. Setting equipment_id while leaving
    // equipment_request_id populated would trip the DB CHECK in production —
    // `assertExactlyOneDisposition` in the updateMany stand-in is what catches it.
    expect(links[0]).toMatchObject({ equipment_id: res.equipmentId, equipment_request_id: null });
  });

  it('honours backfillLink:false — asset created, link left describing', async () => {
    const id = await fileRequest();
    const res = await resolveEquipmentRequest(
      db,
      id,
      { displayName: 'F08 — Forklift', category: 'forklift', backfillLink: false },
      actor,
    );
    expect(res.backfilledLinks).toBe(0);
    expect(links[0]).toMatchObject({ equipment_id: null, equipment_request_id: id });
  });

  it('is ATOMIC — a failure after the create leaves no orphan asset', async () => {
    const id = await fileRequest();
    stampThrows = true;
    await expect(
      resolveEquipmentRequest(db, id, { displayName: 'F09', category: 'forklift' }, actor),
    ).rejects.toThrow(/injected stamp failure/);
    expect(equipment.size).toBe(0);
    expect(reqs.get(id)?.status).toBe('open');
    expect(links[0]).toMatchObject({ equipment_request_id: id });
  });

  it('refuses a duplicate name at the site with a readable message, not a raw P2002', async () => {
    const id = await fileRequest();
    await resolveEquipmentRequest(db, id, { displayName: 'F10', category: 'forklift' }, actor);
    const second = await fileRequest();
    await expect(
      resolveEquipmentRequest(db, second, { displayName: 'F10', category: 'forklift' }, actor),
    ).rejects.toMatchObject({ status: 409, message: /already exists at this site/ });
  });

  it('refuses to resolve a request that is no longer open', async () => {
    const id = await fileRequest();
    await resolveEquipmentRequest(db, id, { displayName: 'F11', category: 'forklift' }, actor);
    await expect(
      resolveEquipmentRequest(db, id, { displayName: 'F12', category: 'forklift' }, actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a blank asset name', async () => {
    const id = await fileRequest();
    await expect(
      resolveEquipmentRequest(db, id, { displayName: '  ', category: 'forklift' }, actor),
    ).rejects.toBeInstanceOf(ApEquipmentRequestError);
  });

  it('audits the resolution in the same transaction, recording the backfill count', async () => {
    const id = await fileRequest();
    await resolveEquipmentRequest(db, id, { displayName: 'F13', category: 'forklift' }, actor);
    const row = audits.find((a) => a.row_id === id && a.action === 'update');
    expect(row?.inTx).toBe(true);
    expect(row?.after).toMatchObject({ status: 'resolved', backfilled_links: 1 });
  });
});

// ── §2.5 — reject ───────────────────────────────────────────────

describe('rejectEquipmentRequest', () => {
  it('requires a note', async () => {
    const id = await fileRequest();
    await expect(rejectEquipmentRequest(db, id, '   ', actor)).rejects.toBeInstanceOf(
      ApEquipmentRequestError,
    );
    expect(reqs.get(id)?.status).toBe('open');
  });

  it('stamps rejected with the note and leaves the link describing', async () => {
    const id = await fileRequest();
    await rejectEquipmentRequest(db, id, 'This was a parts order, not a machine.', actor);
    expect(reqs.get(id)).toMatchObject({
      status: 'rejected',
      resolution_note: 'This was a parts order, not a machine.',
      resolved_by: 'u-morena',
      resolved_equipment_id: null,
    });
    // Deliberately untouched: clearing it would leave the link with NO disposition
    // (a CHECK violation), and flipping it to is_not_equipment_related would
    // rewrite what the approver actually said.
    expect(links[0]).toMatchObject({ equipment_request_id: id, equipment_id: null });
  });

  it('refuses a request that is no longer open', async () => {
    const id = await fileRequest();
    await rejectEquipmentRequest(db, id, 'not equipment', actor);
    await expect(rejectEquipmentRequest(db, id, 'again', actor)).rejects.toMatchObject({
      status: 409,
    });
  });
});

// ── §2.4 — recipients ───────────────────────────────────────────

describe('equipmentRequestRecipients', () => {
  it('routes Woodland to Morena and Eugene to Rick, with Bill CC’d on both', async () => {
    const wood = await equipmentRequestRecipients(db, WOODLAND);
    expect(wood.to.map((t) => t.name)).toContain('Morena Gomez');
    expect(wood.to.map((t) => t.name)).not.toContain('Rick Albritton');
    expect(wood.cc).toContain('u-bill@svdp.us');

    const eug = await equipmentRequestRecipients(db, EUGENE);
    expect(eug.to.map((t) => t.name)).toContain('Rick Albritton');
    expect(eug.to.map((t) => t.name)).not.toContain('Morena Gomez');
    expect(eug.cc).toContain('u-bill@svdp.us');
  });

  it('excludes managers WITHOUT the grant — this is not "every manager"', async () => {
    const eug = await equipmentRequestRecipients(db, EUGENE);
    expect(eug.to.map((t) => t.name)).not.toContain('Patrick Dills');
  });

  it('falls back to the admins rather than resolving to NOBODY', async () => {
    // The ADR-0066 §B.5 failure mode: a fail-soft send over an empty recipient set
    // is indistinguishable from success, and invoices sat invisible for days.
    users.get('u-morena')!.can_resolve_equipment_requests = false;
    const wood = await equipmentRequestRecipients(db, WOODLAND);
    expect(wood.to.length).toBeGreaterThan(0);
    expect(wood.to.map((t) => t.address)).toContain('u-bill@svdp.us');
  });
});
