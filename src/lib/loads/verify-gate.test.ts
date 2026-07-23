// ADR-0037 D2 (Q8) — verify-gate tests. Pure split-assert boundary cases +
// a mocked-prisma path proving the gate blocks a bad split and audits a good one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockLoad {
  id: string;
  site_id: string;
  status: string;
  total_units: number | null;
  source: { is_non_program: boolean; state?: string | null } | null;
  // ADR-0041 (capture half) — present on real selects; optional here so the
  // pre-0041 cases (no site/dr3) exercise the "no DR3# issued" path unchanged.
  site?: { jurisdiction: string } | null;
  dr3_number?: string | null;
}
const store = {
  load: null as MockLoad | null,
  updates: [] as unknown[],
  audits: [] as unknown[],
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboundLoad: {
      findUnique: async () => store.load,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        inboundLoad: {
          update: async ({ data }: { data: unknown }) => {
            store.updates.push(data);
            return {};
          },
        },
        auditLog: {
          create: async ({ data }: { data: unknown }) => {
            store.audits.push(data);
            return {};
          },
        },
      };
      return fn(tx);
    },
  },
}));

// ADR-0041 (capture half) — issuance is exercised for real in sequences.test.ts;
// here it is stubbed so the verify-gate test asserts only the WIRING (issue when
// CA + dr3 null; skip otherwise). The real siteGetsVisionDr3Number / constant pass
// through so the jurisdiction trigger is genuinely under test.
vi.mock('@/lib/events/sequences', async (orig) => {
  const actual = await orig<typeof import('@/lib/events/sequences')>();
  return { ...actual, issueDocumentNumber: vi.fn(async () => 5000) };
});

import {
  assertProgramSplit,
  defaultProgramSplit,
  verifyLoad,
  VerifyGateError,
} from './verify-gate';
import { issueDocumentNumber } from '@/lib/events/sequences';

const issueMock = issueDocumentNumber as unknown as ReturnType<typeof vi.fn>;

describe('assertProgramSplit — pure boundary math', () => {
  it('passes when program + non-program equals total', () => {
    expect(() => assertProgramSplit(175, 150, 25)).not.toThrow();
    expect(() => assertProgramSplit(0, 0, 0)).not.toThrow();
  });

  it('throws split_mismatch when the split does not reconcile', () => {
    try {
      assertProgramSplit(175, 150, 24);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VerifyGateError);
      expect((e as VerifyGateError).reason).toBe('split_mismatch');
    }
  });

  it('throws missing_total when total_units is null', () => {
    try {
      assertProgramSplit(null, 10, 5);
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as VerifyGateError).reason).toBe('missing_total');
    }
  });

  it('throws invalid_split on negative or fractional inputs', () => {
    expect(() => assertProgramSplit(10, -1, 11)).toThrow(VerifyGateError);
    expect(() => assertProgramSplit(10, 5.5, 4.5)).toThrow(VerifyGateError);
  });
});

describe('defaultProgramSplit — source-driven default (B7)', () => {
  it('non-program source → all units non-program', () => {
    expect(defaultProgramSplit(175, true)).toEqual({ programUnits: 0, nonProgramUnits: 175 });
  });
  it('program source → all units program', () => {
    expect(defaultProgramSplit(175, false)).toEqual({ programUnits: 175, nonProgramUnits: 0 });
  });
});

describe('verifyLoad — server-side gate', () => {
  beforeEach(() => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 175,
      source: { is_non_program: false },
    };
    store.updates.length = 0;
    store.audits.length = 0;
  });

  it('verifies a submitted load with a reconciling split and writes an audit row', async () => {
    await verifyLoad({
      loadId: 'L1',
      siteId: 'S1',
      verifierUserId: 'U1',
      programUnits: 150,
      nonProgramUnits: 25,
    });
    expect(store.updates).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
    const upd = store.updates[0] as { status: string; program_unit_count: number };
    expect(upd.status).toBe('verified');
    expect(upd.program_unit_count).toBe(150);
  });

  it('defaults the split from a NON-PROGRAM source when no split is supplied (B7)', async () => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 175,
      source: { is_non_program: true },
    };
    await verifyLoad({ loadId: 'L1', siteId: 'S1', verifierUserId: 'U1' });
    const upd = store.updates[0] as { program_unit_count: number; non_program_unit_count: number };
    expect(upd.program_unit_count).toBe(0);
    expect(upd.non_program_unit_count).toBe(175);
  });

  it('defaults all-program from a PROGRAM source when no split is supplied (B7)', async () => {
    await verifyLoad({ loadId: 'L1', siteId: 'S1', verifierUserId: 'U1' });
    const upd = store.updates[0] as { program_unit_count: number; non_program_unit_count: number };
    expect(upd.program_unit_count).toBe(175);
    expect(upd.non_program_unit_count).toBe(0);
  });

  it('defaults NON-PROGRAM from an OUT-OF-STATE source (state ≠ recycler state), even with is_non_program=false', async () => {
    // OR-generated units delivered to a CA (Woodland) recycler → out-of-state → non-program.
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 175,
      source: { is_non_program: false, state: 'OR' },
      site: { jurisdiction: 'california' },
    };
    await verifyLoad({ loadId: 'L1', siteId: 'S1', verifierUserId: 'U1' });
    const upd = store.updates[0] as { program_unit_count: number; non_program_unit_count: number };
    expect(upd.program_unit_count).toBe(0);
    expect(upd.non_program_unit_count).toBe(175);
  });

  it('defaults ALL-PROGRAM from an in-state source (state = recycler state), is_non_program=false', async () => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 175,
      source: { is_non_program: false, state: 'CA' },
      site: { jurisdiction: 'california' },
    };
    await verifyLoad({ loadId: 'L1', siteId: 'S1', verifierUserId: 'U1' });
    const upd = store.updates[0] as { program_unit_count: number; non_program_unit_count: number };
    expect(upd.program_unit_count).toBe(175);
    expect(upd.non_program_unit_count).toBe(0);
  });

  it('THROWS no_source_for_default (422) when source is null AND no split supplied — never defaults blind', async () => {
    store.load = { id: 'L1', site_id: 'S1', status: 'submitted', total_units: 175, source: null };
    try {
      await verifyLoad({ loadId: 'L1', siteId: 'S1', verifierUserId: 'U1' });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VerifyGateError);
      expect((e as VerifyGateError).reason).toBe('no_source_for_default');
      expect((e as VerifyGateError).status).toBe(422);
    }
    expect(store.updates).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('still verifies a null-source load when an EXPLICIT reconciling split is supplied', async () => {
    store.load = { id: 'L1', site_id: 'S1', status: 'submitted', total_units: 175, source: null };
    await verifyLoad({
      loadId: 'L1',
      siteId: 'S1',
      verifierUserId: 'U1',
      programUnits: 100,
      nonProgramUnits: 75,
    });
    expect(store.updates).toHaveLength(1);
    const upd = store.updates[0] as { program_unit_count: number; non_program_unit_count: number };
    expect(upd.program_unit_count).toBe(100);
    expect(upd.non_program_unit_count).toBe(75);
  });

  it('rejects a half-supplied split (both or neither)', async () => {
    await expect(
      verifyLoad({ loadId: 'L1', siteId: 'S1', verifierUserId: 'U1', programUnits: 100 }),
    ).rejects.toBeInstanceOf(VerifyGateError);
  });

  it('blocks (no writes) when the split does not reconcile', async () => {
    await expect(
      verifyLoad({
        loadId: 'L1',
        siteId: 'S1',
        verifierUserId: 'U1',
        programUnits: 150,
        nonProgramUnits: 20,
      }),
    ).rejects.toBeInstanceOf(VerifyGateError);
    expect(store.updates).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('refuses a load not in submitted state (409 wrong_state)', async () => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'in_progress',
      total_units: 175,
      source: { is_non_program: false },
    };
    try {
      await verifyLoad({
        loadId: 'L1',
        siteId: 'S1',
        verifierUserId: 'U1',
        programUnits: 150,
        nonProgramUnits: 25,
      });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as VerifyGateError).reason).toBe('wrong_state');
      expect((e as VerifyGateError).status).toBe(409);
    }
  });

  it('refuses a load at another site', async () => {
    await expect(
      verifyLoad({
        loadId: 'L1',
        siteId: 'OTHER',
        verifierUserId: 'U1',
        programUnits: 150,
        nonProgramUnits: 25,
      }),
    ).rejects.toBeInstanceOf(VerifyGateError);
  });
});

describe('verifyLoad — ADR-0041 DR3# issuance at the office verify step', () => {
  beforeEach(() => {
    issueMock.mockClear();
    store.updates.length = 0;
    store.audits.length = 0;
  });

  it('issues a Vision DR3# for a CA-jurisdiction load with none yet, stamped as a string', async () => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 175,
      source: { is_non_program: false },
      site: { jurisdiction: 'california' },
      dr3_number: null,
    };
    await verifyLoad({
      loadId: 'L1',
      siteId: 'S1',
      verifierUserId: 'U1',
      programUnits: 175,
      nonProgramUnits: 0,
    });
    expect(issueMock).toHaveBeenCalledTimes(1);
    const upd = store.updates[0] as { dr3_number?: string };
    expect(upd.dr3_number).toBe('5000');
  });

  it('does NOT issue for an Oregon load (dr3_number left unset)', async () => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 10,
      source: { is_non_program: false },
      site: { jurisdiction: 'oregon' },
      dr3_number: null,
    };
    await verifyLoad({
      loadId: 'L1',
      siteId: 'S1',
      verifierUserId: 'U1',
      programUnits: 10,
      nonProgramUnits: 0,
    });
    expect(issueMock).not.toHaveBeenCalled();
    const upd = store.updates[0] as { dr3_number?: string };
    expect(upd.dr3_number).toBeUndefined();
  });

  it('does NOT re-issue when the load already carries a DR3#', async () => {
    store.load = {
      id: 'L1',
      site_id: 'S1',
      status: 'submitted',
      total_units: 10,
      source: { is_non_program: false },
      site: { jurisdiction: 'california' },
      dr3_number: '4805',
    };
    await verifyLoad({
      loadId: 'L1',
      siteId: 'S1',
      verifierUserId: 'U1',
      programUnits: 10,
      nonProgramUnits: 0,
    });
    expect(issueMock).not.toHaveBeenCalled();
  });
});
