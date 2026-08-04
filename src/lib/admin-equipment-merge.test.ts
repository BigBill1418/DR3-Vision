// ADR-0075 D4 — merging two records of one machine onto a survivor.
//
// What these lock down, in order of how much a regression would cost:
//
//   1. THE MONEY INVARIANT. A merge repoints ATTRIBUTION and nothing else. It
//      must never write `ap_requests` — not the status, not the amounts, not
//      `decided_by`/`decided_at`. The approval already happened and the money
//      already moved; a bookkeeping correction to WHICH machine an invoice names
//      cannot be allowed to reach back into the decision. Asserted the only way
//      that actually holds: the `apRequest` writers are spies, and they must
//      never be called at all. A comment cannot enforce this — the test does.
//      (Falsified during development: adding an `ap_requests` write to
//      `mergeEquipment` turns this red, as recorded in the ADR-0075 changelog.)
//   2. Both attribution tables repoint, in ONE transaction with the audit row.
//   3. The loser is KEPT — deactivated and stamped, never deleted. Its links are
//      financial-approval evidence and `onDelete: Restrict` forbids removing it.
//   4. The refusals: self-merge, cross-site (hard rule #2), already-merged either
//      side (a chain would make `merged_into_id` a linked list nothing follows).

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Equip {
  id: string;
  site_id: string;
  display_name: string;
  category: string;
  is_active: boolean;
  merged_into_id: string | null;
  merged_by: string | null;
  merged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
interface Link {
  id: string;
  equipment_id: string | null;
}
interface Req {
  id: string;
  resolved_equipment_id: string | null;
}
interface AuditRow {
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
  /** True when written through a transaction client, not the bare prisma. */
  inTx: boolean;
}

const EUGENE = 'site-eugene';
const WOODLAND = 'site-woodland';

const equipment = new Map<string, Equip>();
const links: Link[] = [];
const reqs: Req[] = [];
const audits: AuditRow[] = [];

/**
 * The `ap_requests` writers. These exist ONLY to be asserted un-called — they are
 * the money invariant's tripwire.
 */
const apRequestUpdate = vi.fn();
const apRequestUpdateMany = vi.fn();

function addEquip(e: Partial<Equip> & { id: string; site_id: string; display_name: string }): void {
  equipment.set(e.id, {
    category: 'vehicle',
    is_active: true,
    merged_into_id: null,
    merged_by: null,
    merged_at: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...e,
  } as Equip);
}

function reset(): void {
  equipment.clear();
  links.length = 0;
  reqs.length = 0;
  audits.length = 0;
  apRequestUpdate.mockReset();
  apRequestUpdateMany.mockReset();

  // The production shape this ADR was written for: three rows, one Terex machine,
  // all at Woodland, each cited by a different approved invoice.
  addEquip({ id: 'eq-terex', site_id: WOODLAND, display_name: 'Terex' });
  addEquip({ id: 'eq-machine', site_id: WOODLAND, display_name: 'Terex Machine' });
  addEquip({ id: 'eq-machine-lc', site_id: WOODLAND, display_name: 'Terex machine' });
  addEquip({ id: 'eq-eugene', site_id: EUGENE, display_name: 'Terex Machine' });

  links.push({ id: 'link-1', equipment_id: 'eq-terex' });
  links.push({ id: 'link-2', equipment_id: 'eq-machine-lc' });
  links.push({ id: 'link-3', equipment_id: 'eq-machine' });
  reqs.push({ id: 'req-1', resolved_equipment_id: 'eq-machine-lc' });
}

function client(inTx: boolean) {
  return {
    equipment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const e = equipment.get(where.id);
        return e ? { ...e } : null;
      }),
      findMany: vi.fn(async () => Array.from(equipment.values()).map((e) => ({ ...e }))),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const e = equipment.get(where.id);
          if (!e) throw new Error('no such equipment');
          Object.assign(e, data);
          return { ...e };
        },
      ),
    },
    apEquipmentLink: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { equipment_id: string };
          data: { equipment_id: string };
        }) => {
          let count = 0;
          for (const l of links) {
            if (l.equipment_id !== where.equipment_id) continue;
            l.equipment_id = data.equipment_id;
            count += 1;
          }
          return { count };
        },
      ),
      groupBy: vi.fn(async () => []),
      count: vi.fn(
        async ({ where }: { where: { equipment_id: string } }) =>
          links.filter((l) => l.equipment_id === where.equipment_id).length,
      ),
    },
    apEquipmentRequest: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { resolved_equipment_id: string };
          data: { resolved_equipment_id: string };
        }) => {
          let count = 0;
          for (const r of reqs) {
            if (r.resolved_equipment_id !== where.resolved_equipment_id) continue;
            r.resolved_equipment_id = data.resolved_equipment_id;
            count += 1;
          }
          return { count };
        },
      ),
      count: vi.fn(
        async ({ where }: { where: { resolved_equipment_id: string } }) =>
          reqs.filter((r) => r.resolved_equipment_id === where.resolved_equipment_id).length,
      ),
    },
    // THE TRIPWIRE. Every write path on the invoice itself, wired to spies that
    // must stay un-called.
    apRequest: { update: apRequestUpdate, updateMany: apRequestUpdateMany },
    site: {
      findMany: vi.fn(async () => [
        { id: EUGENE, code: 'eugene', name: 'DR3 Eugene' },
        { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' },
      ]),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push({
          action: data['action'] as string,
          table_name: data['table_name'] as string,
          row_id: data['row_id'] as string,
          before: data['before'],
          after: data['after'],
          inTx,
        });
      }),
    },
  };
}

const fakePrisma = {
  ...client(false),
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    // A REAL rollback is what makes "one transaction" mean anything.
    const snapshot = {
      equipment: new Map(Array.from(equipment, ([k, v]) => [k, { ...v }])),
      links: links.map((l) => ({ ...l })),
      reqs: reqs.map((r) => ({ ...r })),
      audits: audits.length,
    };
    try {
      return await fn(client(true));
    } catch (e) {
      equipment.clear();
      for (const [k, v] of snapshot.equipment) equipment.set(k, v);
      links.length = 0;
      links.push(...snapshot.links);
      reqs.length = 0;
      reqs.push(...snapshot.reqs);
      audits.length = snapshot.audits;
      throw e;
    }
  }),
};

const holder = vi.hoisted(() => ({ current: null as unknown as Record<string, unknown> }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => holder.current[prop],
  }),
}));
holder.current = fakePrisma as unknown as Record<string, unknown>;

import { mergeEquipment, equipmentReferenceCounts } from './admin-equipment';

const actor = { actorUserId: 'u-bill', ip: '10.0.0.1', userAgent: 'vitest' };

beforeEach(reset);

describe('mergeEquipment — the repoint', () => {
  it('repoints BOTH attribution tables onto the winner', async () => {
    const res = await mergeEquipment('eq-machine', 'eq-machine-lc', actor);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repointedLinks).toBe(1);
    expect(res.repointedRequests).toBe(1);

    expect(links.find((l) => l.id === 'link-2')?.equipment_id).toBe('eq-machine');
    expect(reqs.find((r) => r.id === 'req-1')?.resolved_equipment_id).toBe('eq-machine');
    // Untouched rows stay put — the merge is scoped to the loser, not a sweep.
    expect(links.find((l) => l.id === 'link-1')?.equipment_id).toBe('eq-terex');
  });

  it('KEEPS the loser: deactivated and stamped, never deleted', async () => {
    await mergeEquipment('eq-machine', 'eq-machine-lc', actor);

    const loser = equipment.get('eq-machine-lc');
    expect(loser).toBeDefined();
    expect(loser).toMatchObject({
      is_active: false,
      merged_into_id: 'eq-machine',
      merged_by: 'u-bill',
      // The name survives untouched — which is exactly why the seed has to follow
      // `merged_into_id` rather than trusting a name match (ADR-0075 D5).
      display_name: 'Terex machine',
    });
    expect(loser?.merged_at).toBeInstanceOf(Date);
    expect(equipment.size).toBe(4);
  });

  it('writes the audit row INSIDE the transaction, carrying the repoint counts', async () => {
    await mergeEquipment('eq-machine', 'eq-machine-lc', actor);

    const row = audits.find((a) => a.table_name === 'equipment' && a.row_id === 'eq-machine-lc');
    expect(row?.action).toBe('update');
    expect(row?.inTx).toBe(true);
    expect(row?.after).toMatchObject({
      merged_into_id: 'eq-machine',
      merged_into_display_name: 'Terex Machine',
      repointed_links: 1,
      repointed_equipment_requests: 1,
    });
    // before/after both present — the state at merge time is what preserves the
    // pre-merge attribution for anyone auditing an approval later.
    expect(row?.before).toMatchObject({ is_active: true, merged_into_id: null });
  });
});

// ── THE MONEY INVARIANT ─────────────────────────────────────────────

describe('mergeEquipment — the money invariant', () => {
  it('NEVER writes ap_requests — not on the happy path', async () => {
    await mergeEquipment('eq-machine', 'eq-machine-lc', actor);
    expect(apRequestUpdate).not.toHaveBeenCalled();
    expect(apRequestUpdateMany).not.toHaveBeenCalled();
  });

  it('NEVER writes ap_requests — not on any refusal path either', async () => {
    await mergeEquipment('eq-machine', 'eq-machine', actor); // same row
    await mergeEquipment('eq-machine', 'eq-eugene', actor); // cross-site
    await mergeEquipment('eq-machine', 'nope', actor); // missing
    expect(apRequestUpdate).not.toHaveBeenCalled();
    expect(apRequestUpdateMany).not.toHaveBeenCalled();
  });
});

// ── Refusals ────────────────────────────────────────────────────────

describe('mergeEquipment — refusals', () => {
  it('refuses a self-merge', async () => {
    expect(await mergeEquipment('eq-machine', 'eq-machine', actor)).toEqual({
      ok: false,
      reason: 'same_row',
    });
  });

  it('refuses a CROSS-SITE merge (hard rule #2)', async () => {
    const res = await mergeEquipment('eq-machine', 'eq-eugene', actor);
    expect(res).toEqual({ ok: false, reason: 'cross_site' });
    // and nothing moved
    expect(equipment.get('eq-eugene')?.merged_into_id).toBeNull();
  });

  it('refuses when either side was ALREADY merged — no chains', async () => {
    await mergeEquipment('eq-machine', 'eq-machine-lc', actor);

    expect(await mergeEquipment('eq-terex', 'eq-machine-lc', actor)).toEqual({
      ok: false,
      reason: 'loser_merged',
    });
    expect(await mergeEquipment('eq-machine-lc', 'eq-terex', actor)).toEqual({
      ok: false,
      reason: 'winner_merged',
    });
    // The first merge stands, unchanged, after both refusals.
    expect(equipment.get('eq-machine-lc')?.merged_into_id).toBe('eq-machine');
  });

  it('refuses an unknown id on either side', async () => {
    expect(await mergeEquipment('eq-machine', 'nope', actor)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await mergeEquipment('nope', 'eq-machine', actor)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('leaves NOTHING repointed when a merge is refused', async () => {
    await mergeEquipment('eq-machine', 'eq-eugene', actor);
    expect(links.find((l) => l.id === 'link-2')?.equipment_id).toBe('eq-machine-lc');
    expect(reqs.find((r) => r.id === 'req-1')?.resolved_equipment_id).toBe('eq-machine-lc');
    expect(audits).toHaveLength(0);
  });
});

describe('equipmentReferenceCounts', () => {
  it('counts both sides so the admin can see which row should survive', async () => {
    expect(await equipmentReferenceCounts('eq-machine-lc')).toEqual({ links: 1, requests: 1 });
    expect(await equipmentReferenceCounts('eq-terex')).toEqual({ links: 1, requests: 0 });
  });
});
