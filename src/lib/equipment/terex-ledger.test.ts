// ADR-0077 D6 — the machine ledger's math, pinned so it cannot drift quietly.
//
// Five totals, each with a reason it is here rather than a number someone liked:
//
//   1. Confirmed repairs = $77,067.94 — NOT $154,135.88. The workbook's
//      `Maintenance Log 2025` sheet is a strict SUBSET of `Maintenance Log2026`,
//      and both report the same totals, so a pipeline that takes both without
//      de-duplication reports exactly double. The fixture below MAKES that
//      failure reachable: the subset rows are present in the table as `staged`,
//      so the moment the confirmed-only filter regresses, this assertion reads
//      15413588 and goes red. It is the same fixture that arms the staged-leak
//      guard — one fixture, two failures, both real.
//   2. Confirmed credited = $4,025.36, same shape.
//   3. AP total = 202,492 cents across 4 links on ONE equipment id — the
//      production conservation figure from the ADR-0077 merge. Money is read
//      `confirmed_amount_cents ?? amount_cents`, because all four production rows
//      carry it in the confirmed column with `amount_cents` NULL; reading the
//      other one alone reports 0 and would "pass" a naive test.
//   4. Downtime = Σ non-NULL `hours_down`, and ZERO ROWS ⇒ null, never 0.0.
//   5. Linked spend <= total spend. v1 does no matching so linked is 0; the
//      guard exists now so it is already in place when matching arrives.
//
// Plus the two that are about honesty rather than arithmetic: staged money NEVER
// reaches this surface, and an empty maintenance log announces itself as
// awaiting acceptance rather than as a machine that never broke.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const TEREX = 'eq-terex';

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

interface MaintRow {
  id: string;
  site_id: string;
  status: string;
  sheet_name: string;
  row_index: number;
  event_date: Date | null;
  event_date_raw: string | null;
  issue: string | null;
  measures_taken: string | null;
  estimated_time_cost: string | null;
  actual_repair_cost: Prisma.Decimal | null;
  amount_credited: Prisma.Decimal | null;
}

const store = {
  equipment: [] as {
    id: string;
    site_id: string;
    display_name: string;
    category: string;
    merged_into_id: string | null;
  }[],
  maint: [] as MaintRow[],
  links: [] as {
    id: string;
    request_id: string;
    equipment_id: string;
    created_at: Date;
    request: {
      received_at: Date;
      vendor: string | null;
      vendor_freeform: string | null;
      amount_cents: number | null;
      confirmed_amount_cents: number | null;
    };
  }[],
  events: [] as {
    site_id: string;
    equipment_code: string;
    voided_at: Date | null;
    hours_down: Prisma.Decimal | null;
  }[],
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    equipment: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = store.equipment.find(
          (e) =>
            e.id === where['id'] && e.site_id === where['site_id'] && e.merged_into_id === null,
        );
        return row ?? null;
      }),
    },
    docTerexMaintenanceRow: {
      // `status` is filtered ONLY when the caller supplies it. That is what makes
      // the falsification honest: drop the `status: 'confirmed'` clause from the
      // module and this mock returns the staged subset rows too, so the repair
      // total reads exactly $154,135.88 — the real double-count — rather than
      // collapsing to an empty list and going red for the wrong reason.
      findMany: vi.fn(async ({ where }: { where: { site_id: string; status?: string } }) =>
        store.maint.filter(
          (r) =>
            r.site_id === where.site_id &&
            (where.status === undefined || r.status === where.status),
        ),
      ),
    },
    apEquipmentLink: {
      findMany: vi.fn(async ({ where }: { where: { equipment_id: string } }) =>
        store.links.filter((l) => l.equipment_id === where.equipment_id),
      ),
    },
    equipmentEvent: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { site_id: string; equipment_code: string; voided_at: null };
        }) =>
          store.events.filter(
            (e) =>
              e.site_id === where.site_id &&
              e.equipment_code === where.equipment_code &&
              e.voided_at === null,
          ),
      ),
    },
  },
}));

import { computeTerexLedger } from './terex-ledger';

let seq = 0;
function maint(
  status: string,
  repair: number | null,
  credited: number | null,
  over: Partial<MaintRow> = {},
): MaintRow {
  seq += 1;
  return {
    id: `m${seq}`,
    site_id: WOODLAND,
    status,
    sheet_name: 'Maintenance Log2026',
    row_index: seq,
    event_date: new Date('2026-03-04T00:00:00Z'),
    event_date_raw: '03/04/2026',
    issue: 'shaft',
    measures_taken: 'replaced',
    estimated_time_cost: '2 weeks',
    actual_repair_cost: repair === null ? null : dec(repair),
    amount_credited: credited === null ? null : dec(credited),
    ...over,
  };
}

/**
 * The production shape, in miniature.
 *
 * CONFIRMED rows total exactly 77067.94 / 4025.36 — the ADR-0069 Am.2 figures.
 * STAGED rows mirror them, standing in for the subset sheet that absorption has
 * de-duplicated but not accepted. If the confirmed-only filter ever breaks, the
 * repair total reads 154135.88 — the exact number ADR-0069 Am.2 exists to prevent.
 */
function seedProductionShape(): void {
  store.equipment.push({
    id: TEREX,
    site_id: WOODLAND,
    display_name: 'Terex',
    category: 'terex',
    merged_into_id: null,
  });

  store.maint.push(
    maint('confirmed', 50000, 4000),
    maint('confirmed', 27067.94, 25.36),
    // the subset sheet, absorbed but NOT accepted — identical money
    maint('staged', 50000, 4000),
    maint('staged', 27067.94, 25.36),
  );

  // The four production invoices: money in `confirmed_amount_cents`,
  // `amount_cents` NULL. 55790 + 44910 + 48544 + 53248 = 202492.
  for (const [i, cents] of [55790, 44910, 48544, 53248].entries()) {
    store.links.push({
      id: `link${i}`,
      request_id: `req${i}`,
      equipment_id: TEREX,
      created_at: new Date(`2026-0${i + 1}-01T00:00:00Z`),
      request: {
        received_at: new Date(`2026-0${i + 1}-02T00:00:00Z`),
        vendor: 'InterState Oil Co',
        vendor_freeform: null,
        amount_cents: null,
        confirmed_amount_cents: cents,
      },
    });
  }
}

/**
 * The machine, minimally: the equipment row PLUS one Terex invoice. The invoice
 * is not decoration — `isSiteTerexMachine` uses it to tell the machine apart
 * from the shear machines that share its `terex` category.
 */
function seedMachine(): void {
  store.equipment.push({
    id: TEREX,
    site_id: WOODLAND,
    display_name: 'Terex',
    category: 'terex',
    merged_into_id: null,
  });
  store.links.push({
    id: 'link-id',
    request_id: 'req-id',
    equipment_id: TEREX,
    created_at: new Date('2026-07-01T00:00:00Z'),
    request: {
      received_at: new Date('2026-07-02T00:00:00Z'),
      vendor: 'InterState Oil Co',
      vendor_freeform: null,
      amount_cents: null,
      confirmed_amount_cents: 1_000,
    },
  });
}

beforeEach(() => {
  store.equipment.length = 0;
  store.maint.length = 0;
  store.links.length = 0;
  store.events.length = 0;
  seq = 0;
});

describe('computeTerexLedger — the pinned totals (ADR-0077 D6)', () => {
  it('1. confirmed repairs total $77,067.94 — not $154,135.88', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.maintenance.totalRepairCents).toBe(7_706_794);
    expect(l.maintenance.totalRepairCents).not.toBe(15_413_588);
  });

  it('2. confirmed credited totals $4,025.36', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.maintenance.totalCreditedCents).toBe(402_536);
  });

  it('3. AP total is 202,492 cents across 4 links on ONE id', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.ap.invoices).toHaveLength(4);
    expect(l.ap.totalCents).toBe(202_492);
  });

  it('3b. reads confirmed_amount_cents — amount_cents alone would report 0', async () => {
    seedProductionShape();
    expect(store.links.every((l) => l.request.amount_cents === null)).toBe(true);
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.ap.totalCents).toBeGreaterThan(0);
  });

  it('5. linked spend never exceeds total spend (v1: linked is 0)', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.ap.linkedCents).toBe(0);
    expect(l.ap.linkedCents).toBeLessThanOrEqual(l.ap.totalCents);
  });
});

describe('computeTerexLedger — downtime (ADR-0077 D4)', () => {
  it('4. sums only non-NULL hours_down', async () => {
    seedProductionShape();
    store.events.push(
      { site_id: WOODLAND, equipment_code: 'terex', voided_at: null, hours_down: dec(3.5) },
      { site_id: WOODLAND, equipment_code: 'terex', voided_at: null, hours_down: dec(1.25) },
      { site_id: WOODLAND, equipment_code: 'terex', voided_at: null, hours_down: null },
    );
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.downtime.totalHours).toBe(4.75);
    expect(l.downtime.eventsWithHours).toBe(2);
    expect(l.downtime.eventsConsidered).toBe(3);
  });

  it('4b. zero recorded rows ⇒ null ("not recorded"), never 0.0', async () => {
    seedProductionShape();
    // The production shape: events exist, none carries an hours_down.
    store.events.push(
      { site_id: WOODLAND, equipment_code: 'terex', voided_at: null, hours_down: null },
      { site_id: WOODLAND, equipment_code: 'terex', voided_at: null, hours_down: null },
    );
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.downtime.totalHours).toBeNull();
    expect(l.downtime.eventsConsidered).toBe(2);
  });

  it('4c. a genuine recorded zero stays 0 — absence and zero are different facts', async () => {
    seedProductionShape();
    store.events.push({
      site_id: WOODLAND,
      equipment_code: 'terex',
      voided_at: null,
      hours_down: dec(0),
    });
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.downtime.totalHours).toBe(0);
  });
});

describe('computeTerexLedger — staged money never reaches the surface', () => {
  it('excludes staged rows entirely — they are a proposal, not a fact', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    // Four maintenance rows exist; only the two CONFIRMED ones are returned.
    expect(store.maint).toHaveLength(4);
    expect(l.maintenance.events).toHaveLength(2);
    expect(l.maintenance.totalRepairCents).toBe(7_706_794);
  });

  it('an all-staged log reports awaiting-absorption, not a clean machine', async () => {
    seedMachine();
    store.maint.push(maint('staged', 50000, 4000));

    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.maintenance.awaitingAbsorption).toBe(true);
    expect(l.maintenance.events).toHaveLength(0);
    // NOT 0 — "nobody has accepted any repairs" is not "this machine cost nothing".
    expect(l.maintenance.totalRepairCents).toBeNull();
    expect(l.maintenance.totalCreditedCents).toBeNull();
  });

  it('TODAY’s live shape: AP half populated, maintenance half honestly empty', async () => {
    // Exactly production as of 2026-08-06 — zero confirmed rows, four invoices.
    store.equipment.push({
      id: TEREX,
      site_id: WOODLAND,
      display_name: 'Terex',
      category: 'terex',
      merged_into_id: null,
    });
    for (const [i, cents] of [55790, 44910, 48544, 53248].entries()) {
      store.links.push({
        id: `link${i}`,
        request_id: `req${i}`,
        equipment_id: TEREX,
        created_at: new Date('2026-07-01T00:00:00Z'),
        request: {
          received_at: new Date('2026-07-02T00:00:00Z'),
          vendor: 'InterState Oil Co',
          vendor_freeform: null,
          amount_cents: null,
          confirmed_amount_cents: cents,
        },
      });
    }

    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.ap.totalCents).toBe(202_492);
    expect(l.maintenance.awaitingAbsorption).toBe(true);
    expect(l.maintenance.totalRepairCents).toBeNull();
    expect(l.downtime.totalHours).toBeNull();
  });
});

describe('computeTerexLedger — the money rules that are not sums', () => {
  it('a blank cost stays NULL — an unpriced repair is not a free one', async () => {
    seedMachine();
    store.maint.push(maint('confirmed', null, null));

    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.maintenance.events[0]?.actualRepairCostCents).toBeNull();
    expect(l.maintenance.totalRepairCents).toBeNull();
  });

  it('keeps an unparsed date as raw text and never coerces it', async () => {
    seedMachine();
    store.maint.push(
      maint('confirmed', 100, null, { event_date: null, event_date_raw: '09/16 or 17' }),
    );

    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.maintenance.events[0]?.eventDateISO).toBeNull();
    expect(l.maintenance.events[0]?.eventDateRaw).toBe('09/16 or 17');
  });

  it('passes estimated repair time through verbatim — never parsed as a duration', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.maintenance.events[0]?.estimatedTimeCost).toBe('2 weeks');
  });
});

describe('computeTerexLedger — scoping', () => {
  it('refuses a merged-away row — its attribution lives on the survivor now', async () => {
    store.equipment.push({
      id: 'eq-loser',
      site_id: WOODLAND,
      display_name: 'Terex Machine',
      category: 'vehicle',
      merged_into_id: TEREX,
    });
    const l = await computeTerexLedger(WOODLAND, 'eq-loser');
    expect(l.equipment).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────
  // Bill, 2026-08-06: "the terex machine operates exclusively at woodland —
  // eugene has no use or need for this data at all."
  //
  // The registry does not say that on its own. `category: 'terex'` is the
  // ADR-0062 seed's category for SHEAR MACHINES, and production carries five
  // such rows — `EQ24/EQ43/EQ74 — Shear Machine` at Woodland and `EQ65 — Sheer
  // Machine Shear Machine` at EUGENE — none of which is the machine. Because the
  // maintenance log is keyed by SITE and the events by a free-text
  // `equipment_code`, handing this ledger one of those rows renders the Terex's
  // money and history under a shear machine's name.
  // ────────────────────────────────────────────────────────────────
  it("refuses Eugene's terex-CATEGORY shear machine — the category is not the machine", async () => {
    store.equipment.push({
      id: 'eq65-eugene',
      site_id: EUGENE,
      display_name: 'EQ65 — Sheer Machine Shear Machine',
      category: 'terex',
      merged_into_id: null,
    });
    // Eugene's own Terex maintenance rows would be read if the guard let it past.
    store.maint.push(maint('confirmed', 50000, 4000, { site_id: EUGENE }));

    const l = await computeTerexLedger(EUGENE, 'eq65-eugene');
    expect(l.equipment).toBeNull();
    expect(l.maintenance.events).toHaveLength(0);
    expect(l.maintenance.totalRepairCents).toBeNull();
  });

  it('refuses a Woodland shear machine that carries no Terex invoices', async () => {
    seedProductionShape();
    store.equipment.push({
      id: 'eq24',
      site_id: WOODLAND,
      display_name: 'EQ24 — Shear Machine',
      category: 'terex',
      merged_into_id: null,
    });

    const l = await computeTerexLedger(WOODLAND, 'eq24');
    // The site HAS confirmed maintenance rows — they must not surface here.
    expect(l.equipment).toBeNull();
    expect(l.maintenance.totalRepairCents).toBeNull();
    expect(l.ap.totalCents).toBe(0);
  });

  it('still admits the real machine — the guard is narrow, not a blanket refusal', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.equipment?.displayName).toBe('Terex');
    expect(l.ap.totalCents).toBe(202_492);
  });

  it('refuses an asset from the other site (hard rule #2)', async () => {
    seedProductionShape();
    const l = await computeTerexLedger(EUGENE, TEREX);
    expect(l.equipment).toBeNull();
    expect(l.ap.totalCents).toBe(0);
  });

  it('only counts AP links on THIS equipment id', async () => {
    seedProductionShape();
    store.equipment.push({
      id: 'eq-other',
      site_id: WOODLAND,
      display_name: 'Baler',
      category: 'baler',
      merged_into_id: null,
    });
    store.links.push({
      id: 'link-other',
      request_id: 'req-other',
      equipment_id: 'eq-other',
      created_at: new Date('2026-07-01T00:00:00Z'),
      request: {
        received_at: new Date('2026-07-02T00:00:00Z'),
        vendor: 'Someone Else',
        vendor_freeform: null,
        amount_cents: null,
        confirmed_amount_cents: 999_999,
      },
    });

    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.ap.totalCents).toBe(202_492);
  });

  it('prefers vendor_freeform (keyed at decision) over the parsed vendor', async () => {
    seedProductionShape();
    store.links[0]!.request.vendor_freeform = 'InterState Oil Co.';
    const l = await computeTerexLedger(WOODLAND, TEREX);
    expect(l.ap.invoices[0]?.vendor).toBe('InterState Oil Co.');
  });

  it('offers the AP-history link to admins only — it 403s for managers', async () => {
    seedProductionShape();
    const asAdmin = await computeTerexLedger(WOODLAND, TEREX, { isAdmin: true });
    const asManager = await computeTerexLedger(WOODLAND, TEREX, { isAdmin: false });
    expect(asAdmin.ap.invoices[0]?.decisionHref).toContain('/admin/ap/history');
    expect(asManager.ap.invoices[0]?.decisionHref).toBeNull();
  });
});
