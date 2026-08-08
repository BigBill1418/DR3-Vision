// ADR-0083 — the inventory leg: a save becomes resale stock WITHOUT leaving the
// floor and WITHOUT ever being counted as processed.
//
// Three separate things could go wrong here and each has a different smell:
//   1. double-count — the same mattress counted as both saved and processed;
//   2. the RETRACTED model — a save decrementing the live on-hand floor balance
//      (Kelsey's Addendum-A §A.2 immediate subtraction, which Rick's live model
//      supersedes: saved units stay physically on the floor until a store
//      transfer);
//   3. precedence violation — writing to `processed_units_daily`, which has
//      THREE writers under a precedence rule and is not ours to touch.
//
// This file pins all three, plus the delta semantics that make the append-only
// movement ledger correct under the bonus entry's upsert.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Prisma } from '@prisma/client';
import { recordSavesMovement } from '@/lib/bonus/saves-inventory';

interface MovementRow {
  site_id: string;
  movement_date: Date;
  units: number;
  from_status: string | null;
  to_status: string;
  source: string;
  created_by: string | null;
  note: string | null;
}

let movements: MovementRow[] = [];
let touchedModels: string[] = [];

/**
 * A transaction double that RECORDS which models were touched. The point is not
 * to let `unitStatusMovement.create` succeed — it is to catch a write to any
 * OTHER table. `processed_units_daily` and the snapshot table are reachable on a
 * real `tx`, so a proxy that throws on unexpected access is the only way to
 * assert "this function wrote nothing else".
 */
function makeTx(): Prisma.TransactionClient {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, model: string) {
      touchedModels.push(model);
      if (model === 'unitStatusMovement') {
        return {
          create: async ({ data }: { data: MovementRow }) => {
            movements.push(data);
            return { id: `mv-${movements.length}` };
          },
        };
      }
      throw new Error(
        `saves-inventory wrote to an unexpected model: ${model}. ` +
          `A saves entry may only append to unit_status_movements.`,
      );
    },
  };
  return new Proxy({}, handler) as unknown as Prisma.TransactionClient;
}

const DAY = new Date(Date.UTC(2026, 7, 8));
const base = {
  siteId: 'site-woodland',
  movementDate: DAY,
  entryId: 'entry-1',
  actorUserId: 'user-janette',
};

beforeEach(() => {
  movements = [];
  touchedModels = [];
});

describe('a new saves entry appends an on_floor → saved movement', () => {
  it('records the units, the direction, the day and the source ref', async () => {
    const id = await recordSavesMovement(makeTx(), {
      ...base,
      previousSaves: null,
      currentSaves: 12,
    });

    expect(id).toBe('mv-1');
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      site_id: 'site-woodland',
      movement_date: DAY,
      units: 12,
      from_status: 'on_floor',
      to_status: 'saved',
      created_by: 'user-janette',
    });
    expect(movements[0]!.note).toContain('entry-1');
  });

  it('writes to NOTHING but unit_status_movements', async () => {
    // The precedence guard, executed rather than asserted in prose: the tx
    // double throws on any other model, so a stray `processed_units_daily`
    // write, a snapshot write or an onHand mutation fails this test by name.
    await recordSavesMovement(makeTx(), { ...base, previousSaves: null, currentSaves: 12 });
    expect([...new Set(touchedModels)]).toEqual(['unitStatusMovement']);
    expect(touchedModels).not.toContain('processedUnitsDaily');
    expect(touchedModels).not.toContain('siteInventorySnapshot');
  });
});

describe('corrections append a DELTA, never a restatement', () => {
  it('an upward correction appends only the difference', async () => {
    // The bonus entry is UPSERTED: 10 keyed, then corrected to 14. The ledger is
    // append-only and signed-sum, so the right row is +4 — not a second +14
    // (which would claim 24 units were saved) and not an edit of the first row.
    await recordSavesMovement(makeTx(), { ...base, previousSaves: 10, currentSaves: 14 });

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ units: 4, from_status: 'on_floor', to_status: 'saved' });
    expect(movements[0]!.note).toContain('10 → 14');
  });

  it('a downward correction REVERSES direction rather than writing negative units', async () => {
    // `units` counts units crossing a bucket boundary; a negative count is not a
    // thing that happened. Moving them back to on_floor keeps every row's
    // arithmetic honest and keeps the signed-sum definition working.
    await recordSavesMovement(makeTx(), { ...base, previousSaves: 14, currentSaves: 9 });

    expect(movements[0]).toMatchObject({ units: 5, from_status: 'saved', to_status: 'on_floor' });
    expect(movements[0]!.units).toBeGreaterThan(0);
  });

  it('a no-op edit appends nothing at all', async () => {
    // A note-only save, or re-keying the same number. A 0-unit row would be
    // noise in a ledger whose value is that every row is a thing that happened.
    const id = await recordSavesMovement(makeTx(), {
      ...base,
      previousSaves: 12,
      currentSaves: 12,
    });
    expect(id).toBeNull();
    expect(movements).toHaveLength(0);
  });

  it('the signed sum of a correction sequence equals the final stored value', async () => {
    // The property that makes the ledger trustworthy: replaying the movements
    // must reconstruct the number in the bonus entry.
    const tx = makeTx();
    await recordSavesMovement(tx, { ...base, previousSaves: null, currentSaves: 10 });
    await recordSavesMovement(tx, { ...base, previousSaves: 10, currentSaves: 14 });
    await recordSavesMovement(tx, { ...base, previousSaves: 14, currentSaves: 9 });

    const savedBucket = movements.reduce(
      (sum, m) => sum + (m.to_status === 'saved' ? m.units : -m.units),
      0,
    );
    expect(savedBucket).toBe(9);
  });
});

describe('a save does NOT leave the floor (Rick model, G1 — binding)', () => {
  it('never writes a movement OUT of on_floor to anything but saved', async () => {
    // The retracted Kelsey model would have modelled a save as units leaving
    // inventory. If someone re-introduces it, it shows up as a `to_status` of
    // 'sold' or 'processed' here.
    await recordSavesMovement(makeTx(), { ...base, previousSaves: null, currentSaves: 30 });
    expect(movements[0]!.to_status).toBe('saved');
    expect(['sold', 'processed', 'landfilled']).not.toContain(movements[0]!.to_status);
  });

  it('is invisible to the live on-hand balance because it touches no balance input', async () => {
    // `onHand` sums verified inbound, dropoffs, stripped, whole-units-sold and
    // landfilled against the anchor — and deliberately omits savedUnits. This
    // function writes none of those, so the floor tile cannot move. The tx
    // double proves it by construction (it throws on any other model), so the
    // assertion here is that the ONLY row produced is a saved-bucket movement.
    await recordSavesMovement(makeTx(), { ...base, previousSaves: null, currentSaves: 30 });
    expect(movements.every((m) => m.to_status === 'saved' || m.from_status === 'saved')).toBe(true);
  });
});
