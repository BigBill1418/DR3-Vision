// ADR-0090 C — the honest zero.
//
// JT, 2026-08-10: "I'm not able to fix the pending one under my name, it doesn't
// let me 0 it out... I fixed everybody else's."
//
// She was right that she could not, and so was everybody else: `stage-stacks.tsx`
// refuses a stack of 0 (`unitCount < 1` => 422) and there is no abandon path
// anywhere in the 7-stage workflow. The only remedy to date has been hand-audited
// DB surgery. These tests pin the floor-side one.
//
// The properties that matter, in order of what they protect:
//   1. A voided load NEVER carries units into anything (status allow-lists).
//   2. The `expected_loads` slot is FREED, so the real truck can still check in.
//   3. The reason the operator asserts is recorded — a mis-click and a no-show
//      are different facts (ADR-0077 D4).
//   4. Only the holder may void; the audit row commits with the write.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUnique, update, writeAudit, $transaction } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  writeAudit: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { inboundLoad: { findUnique, update }, $transaction },
}));
vi.mock('@/lib/audit', () => ({ writeAudit }));

import { voidLoad, LoadAccessError } from './load-service';

const SITE = 'site-woodland';
const OP = 'user-janette';
const LOAD = 'load-h136796';
const SLOT = 'expected-h136796';

/** The tx handle the service is handed inside `$transaction`. */
const tx = { inboundLoad: { update } };

function loadRow(over: Record<string, unknown> = {}) {
  return {
    id: LOAD,
    site_id: SITE,
    assigned_operator_id: OP,
    status: 'arrived',
    arrived_at: new Date('2026-08-10T22:49:16.000Z'),
    unload_started_at: null,
    expected_load_id: SLOT,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(loadRow());
  update.mockResolvedValue({ id: LOAD });
  writeAudit.mockResolvedValue(undefined);
  $transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

describe('voidLoad', () => {
  it('moves the load to the terminal `voided` status', async () => {
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'wrong_haul',
      note: null,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[0]?.data).toMatchObject({ status: 'voided' });
  });

  it('FREES the expected-load slot so the real truck can still check in', async () => {
    // THE load-bearing assertion. `inbound_loads.expected_load_id` is UNIQUE, so
    // a voided child that kept its parent would hold the slot forever and
    // `startInboundLoad` would keep handing every future tap back the dead load
    // — the ADR-0074 Am.1 dead end, rebuilt. Severing makes
    // `expected.inbound_load` null again, which is what both check-in surfaces
    // read through `toConsumedLoad`.
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'wrong_haul',
      note: null,
    });
    const data = update.mock.calls[0]?.[0]?.data;
    expect(data?.expected_load_id).toBeNull();
    // ...and the provenance survives the severing, or "which haul did they
    // mis-tap?" becomes unanswerable the moment it is answered.
    expect(data?.voided_from_expected_load_id).toBe(SLOT);
  });

  it('records who, when and why alongside the status', async () => {
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'truck_never_arrived',
      note: null,
    });
    const data = update.mock.calls[0]?.[0]?.data;
    expect(data?.voided_by).toBe(OP);
    expect(data?.void_reason).toBe('truck_never_arrived');
    expect(data?.voided_at).toBeInstanceOf(Date);
  });

  it('writes the audit row INSIDE the same transaction as the update', async () => {
    // ADR-0082 learned this on `startInboundLoad`: an audit written on the global
    // client after the write leaves, on failure, a mutated load with nothing
    // saying who mutated it.
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'wrong_haul',
      note: null,
    });
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit.mock.calls[0]?.[1]).toEqual({ tx });
    const row = writeAudit.mock.calls[0]?.[0];
    expect(row).toMatchObject({ actor_user_id: OP, table_name: 'inbound_loads', row_id: LOAD });
    // Append-only (CLAUDE.md hard rule #6): the audit records the BEFORE status,
    // so the void is reconstructible rather than merely asserted.
    expect(row?.before).toMatchObject({ status: 'arrived', expected_load_id: SLOT });
    expect(row?.after).toMatchObject({ status: 'voided', void_reason: 'wrong_haul' });
  });

  it('requires a note when the reason is `other`', async () => {
    // "Other" with no note records nothing at all — it is a void with the reason
    // field spent and no information in it.
    await expect(
      voidLoad({ loadId: LOAD, operatorUserId: OP, siteId: SITE, reason: 'other', note: '  ' }),
    ).rejects.toMatchObject({ status: 422, reason: 'void_note_required' });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the note for a reason that carries one', async () => {
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'other',
      note: '  driver took it to Eugene  ',
    });
    expect(update.mock.calls[0]?.[0]?.data?.void_note).toBe('driver took it to Eugene');
  });

  it('refuses a load held by someone else', async () => {
    // Only the holder may void. Becoming the holder is the EXISTING ADR-0082
    // takeover, which is audited and names both parties — so "a manager can void
    // it" needs no second authorization path, and inventing one would mean two
    // places that have to agree about who holds a load.
    findUnique.mockResolvedValue(loadRow({ assigned_operator_id: 'user-someone-else' }));
    await expect(
      voidLoad({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        reason: 'wrong_haul',
        note: null,
      }),
    ).rejects.toBeInstanceOf(LoadAccessError);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a load at another site', async () => {
    findUnique.mockResolvedValue(loadRow({ site_id: 'site-eugene' }));
    await expect(
      voidLoad({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        reason: 'wrong_haul',
        note: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(['arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished'] as const)(
    'can void from the open-dock status %s',
    async (status) => {
      // Every state the floor can be stuck in. H-135311 sat at `in_progress` for
      // thirteen days; H-136796 at `arrived`.
      findUnique.mockResolvedValue(loadRow({ status }));
      await voidLoad({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        reason: 'wrong_haul',
        note: null,
      });
      expect(update).toHaveBeenCalledOnce();
    },
  );

  it.each(['submitted', 'verified', 'rejected', 'submitted_to_mymrc', 'processed'] as const)(
    'refuses to void the already-terminal status %s',
    async (status) => {
      // Past `submitted` the load has left the floor's hands and may already be
      // on an MRC invoice. That is ADR-0073's manager-correction territory, and
      // a floor-side void there would silently restate a filed number.
      findUnique.mockResolvedValue(loadRow({ status }));
      await expect(
        voidLoad({
          loadId: LOAD,
          operatorUserId: OP,
          siteId: SITE,
          reason: 'wrong_haul',
          note: null,
        }),
      ).rejects.toMatchObject({ status: 409, reason: 'illegal_transition' });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('is a no-op replay when the load is already voided', async () => {
    // The void is reachable from a screen that may be a stale tab. Re-voiding
    // must not overwrite the original reason, actor or instant with a second
    // operator's — the FIRST void is the one that happened.
    findUnique.mockResolvedValue(loadRow({ status: 'voided' }));
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'truck_never_arrived',
      note: null,
    });
    expect(update).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('tolerates a load that never had an expected-load slot', async () => {
    // A walk-up drop-off (ADR-0085) has no parent to sever.
    findUnique.mockResolvedValue(loadRow({ expected_load_id: null }));
    await voidLoad({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      reason: 'wrong_haul',
      note: null,
    });
    const data = update.mock.calls[0]?.[0]?.data;
    expect(data?.voided_from_expected_load_id).toBeNull();
  });
});
