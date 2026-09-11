import { describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const count = vi.fn();
const siteFindMany = vi.fn(async () => [{ id: 'site-w', code: 'woodland' }]);
vi.mock('@/lib/prisma', () => ({
  prisma: {
    mymrcHaulsMirror: {
      findMany: (...a: unknown[]) => findMany(...a),
      count: (...a: unknown[]) => count(...a),
    },
    site: { findMany: (...a: unknown[]) => siteFindMany(...(a as [])) },
  },
}));

import { LOADS_INVARIANTS, HAUL_UNIT_PLAUSIBILITY_MAX } from './invariants';

const inv = LOADS_INVARIANTS.find((i) => i.id === 'INV-INBOUND-PLAUSIBLE')!;
const ctx = { now: new Date('2026-09-11T08:00:00Z') };

function haul(over: Record<string, unknown> = {}) {
  return {
    external_haul_id: 'H-138391',
    program_unit_count: 6020,
    non_program_unit_count: 0,
    weight_lbs: { toString: () => '331100' },
    container_type: "53' Trailer",
    recycler_reported_delivery_date: new Date('2026-09-04T00:00:00Z'),
    site_id: 'site-w',
    ...over,
  };
}

describe('INV-INBOUND-PLAUSIBLE', () => {
  it('is Tier B — it must never page, because MyMRC is the system of record', () => {
    // ADR-0131 D8 #8 / D1: there is no PROVABLE statement that 6,020 units is
    // false — MyMRC asserts it. Only an implausibility can speak here, and an
    // implausibility never pages.
    expect(inv.tier).toBe('implausibility');
  });

  it('reports a haul above the threshold, with the numbers a human needs', async () => {
    count.mockResolvedValue(1096);
    findMany.mockResolvedValue([haul()]);
    const out = await inv.check(ctx);
    expect(out.status).toBe('violated');
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]!.subject).toContain('H-138391');
    expect(out.violations[0]!.detail).toContain('6020');
    expect(out.violations[0]!.detail).toContain(String(HAUL_UNIT_PLAUSIBILITY_MAX));
  });

  it('counts EVERY live haul as a subject, not just the offenders', async () => {
    // The opportunity count. If it reported only the rows the filter returned, a
    // clean run would be `ok` over 0 subjects and the runner would rewrite it to
    // indeterminate — a permanently "unchecked" invariant that nobody trusts.
    count.mockResolvedValue(1096);
    findMany.mockResolvedValue([]);
    const out = await inv.check(ctx);
    expect(out.status).toBe('ok');
    expect(out.subjectsChecked).toBe(1096);
  });

  it('is indeterminate rather than ok when the mirror holds no hauls at all', async () => {
    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);
    const out = await inv.check(ctx);
    // It returns ok/0 and the RUNNER converts it; assert the honest inputs.
    expect(out.subjectsChecked).toBe(0);
    expect(out.violations).toEqual([]);
  });

  it('queries only LIVE, Delivered, General hauls', async () => {
    count.mockResolvedValue(10);
    findMany.mockResolvedValue([]);
    await inv.check(ctx);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.disappeared_at).toBeNull();
    expect(where.status).toBe('Delivered');
    expect(where.type).toBe('General');
    // A disappeared row is one MRC has already withdrawn; flagging it would page
    // about a correction that already happened.
    expect(count.mock.calls[0]![0].where.disappeared_at).toBeNull();
  });

  it('thresholds on the PER-HAUL mirror, never on inbound_loads', async () => {
    // inbound_loads is a per-site-per-DAY aggregate (ADR-0060 D5). Against
    // production, 598 of its 650 verified rows exceed this threshold legitimately,
    // because a day holds several hauls. Applying it there is a 598-row false
    // positive, and this test pins the table so nobody "simplifies" it later.
    count.mockResolvedValue(10);
    findMany.mockResolvedValue([]);
    await inv.check(ctx);
    expect(findMany).toHaveBeenCalled();
    expect(HAUL_UNIT_PLAUSIBILITY_MAX).toBe(350);
  });
});
