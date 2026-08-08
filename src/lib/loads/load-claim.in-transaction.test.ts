// ADR-0082 D1/D2 — the re-read happens INSIDE the transaction. Asserted, not claimed.
//
// ## Why this test exists and why it is a mock
//
// The ADR's whole atomicity argument rests on a placement: the guard reads
// through the SAME client that performs the write, so nothing it decided on can
// change between the decision and the write. `idempotency.ts` states the rule —
// _"a guard that reads or writes outside the transaction it is guarding is not a
// guard, it is a race with better manners"_ — and ADR-0082 asserts the rule is
// obeyed here. Until now nothing checked it. Moving `tx.inboundLoad.findUnique`
// to `prisma.inboundLoad.findUnique` is a one-character-class edit that reads
// fine in review, leaves every real-DB test green (the compare-and-swap and the
// unique index still hold, because they are the WRITE-side guards), and quietly
// re-opens the read-side window the ADR says is closed.
//
// So: which CLIENT was used is a question about our TypeScript, not about
// Postgres — the exact case where a mock is the right instrument rather than the
// wrong one. The real-DB suite (`load-claim.db.test.ts`) proves the database
// behaviours; this proves the wiring those behaviours depend on. Neither
// substitutes for the other.
//
// FALSIFIED BY HAND (both directions):
//   - `tx.inboundLoad.findUnique` → `prisma.inboundLoad.findUnique` in
//     `takeOverLoad` reds with "read the load through the GLOBAL client".
//   - `tx.expectedLoad.findUnique` → `prisma.expectedLoad.findUnique` in
//     `startInboundLoad` reds the same way.

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A prisma double whose GLOBAL model methods all throw. Any read that escapes
 * the transaction therefore fails LOUDLY and names itself, rather than returning
 * a convenient `undefined` that the assertion could be written around.
 */
const { globalCalls, txCalls, prismaMock } = vi.hoisted(() => {
  const globalCalls: string[] = [];
  const txCalls: string[] = [];

  const escaped = (what: string) => () => {
    globalCalls.push(what);
    throw new Error(`ESCAPED TRANSACTION: read ${what} through the GLOBAL client`);
  };

  const tx = {
    inboundLoad: {
      findUnique: vi.fn(async () => {
        txCalls.push('inboundLoad.findUnique');
        return {
          id: 'L',
          site_id: 'S',
          status: 'in_progress',
          load_source_type: 'b2b_haul',
          assigned_operator_id: 'A',
          assigned_at: new Date('2026-08-06T18:00:00.000Z'),
          assigned_operator: { id: 'A', name: 'Alma Ruiz' },
        };
      }),
      updateMany: vi.fn(async () => {
        txCalls.push('inboundLoad.updateMany');
        return { count: 1 };
      }),
      create: vi.fn(async () => {
        txCalls.push('inboundLoad.create');
        return { id: 'NEW' };
      }),
    },
    expectedLoad: {
      findUnique: vi.fn(async () => {
        txCalls.push('expectedLoad.findUnique');
        return {
          id: 'E',
          site_id: 'S',
          cancelled_at: null,
          source_id: null,
          transporter_id: null,
          bol_number: null,
          inbound_load: null,
        };
      }),
    },
    user: {
      findUnique: vi.fn(async () => {
        txCalls.push('user.findUnique');
        return {
          id: 'B',
          name: 'Bruno Vega',
          role: 'operator',
          is_active: true,
          deleted_at: null,
          primary_site_id: 'S',
        };
      }),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
  };

  const prismaMock = {
    $transaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(tx)),
    inboundLoad: {
      findUnique: escaped('inboundLoad'),
      updateMany: escaped('inboundLoad'),
      create: escaped('inboundLoad'),
    },
    expectedLoad: { findUnique: escaped('expectedLoad') },
    user: { findUnique: escaped('user') },
    auditLog: { create: escaped('auditLog') },
  };

  return { globalCalls, txCalls, prismaMock, tx };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { takeOverLoad } from './load-claim';
import { startInboundLoad } from '@/lib/load-service';

beforeEach(() => {
  globalCalls.length = 0;
  txCalls.length = 0;
  // Call COUNTS as well as the arrays: `$transaction` is asserted to run exactly
  // once per call, and a counter carried over from the previous test makes that
  // assertion measure the file's history instead of this test's behaviour.
  vi.clearAllMocks();
});

describe('takeOverLoad — every read and write goes through the transaction client', () => {
  it('re-reads the load INSIDE the transaction, not before it', async () => {
    const result = await takeOverLoad({
      loadId: 'L',
      operatorUserId: 'B',
      siteId: 'S',
      idempotencyKey: null,
    });

    expect(result.outcome).toBe('taken');
    expect(txCalls).toContain('inboundLoad.findUnique');
    expect(
      globalCalls,
      'the guard read outside the transaction it is guarding — that is a race with better manners',
    ).toEqual([]);
  });

  it('opens exactly ONE transaction and does the compare-and-swap inside it', async () => {
    await takeOverLoad({ loadId: 'L', operatorUserId: 'B', siteId: 'S', idempotencyKey: null });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // Read THEN swap, both on `tx`, in that order — the ordering is the guard.
    expect(txCalls.indexOf('inboundLoad.findUnique')).toBeLessThan(
      txCalls.indexOf('inboundLoad.updateMany'),
    );
  });

  it('writes its audit row through the transaction client too', async () => {
    // ADR-0082 D4: the claim and the record of who moved it commit or roll back
    // together. An audit written on the global client leaves a window where the
    // claim moved and nothing says who moved it.
    await takeOverLoad({ loadId: 'L', operatorUserId: 'B', siteId: 'S', idempotencyKey: null });
    expect(globalCalls).toEqual([]);
  });
});

describe('startInboundLoad — the claim re-read is inside the transaction', () => {
  it('re-reads the parent expected load INSIDE the transaction', async () => {
    const result = await startInboundLoad({
      expectedLoadId: 'E',
      siteId: 'S',
      operatorUserId: 'A',
    });

    expect(result).toEqual({ id: 'NEW', claimed: true });
    expect(txCalls).toContain('expectedLoad.findUnique');
    expect(globalCalls, 'the sequential-window guard read outside its own transaction').toEqual([]);
    // Re-read THEN create — reversing them would mint a duplicate before looking.
    expect(txCalls.indexOf('expectedLoad.findUnique')).toBeLessThan(
      txCalls.indexOf('inboundLoad.create'),
    );
  });
});
