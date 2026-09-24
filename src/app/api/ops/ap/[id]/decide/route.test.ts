// ADR-0046 D4 + Amendment 5 (D-M5-1/4/6) — decide route boundary:
//  - F7-AP free-text caps (note/explanation ≤ 2000, vendor ≤ 200) BEFORE any state change
//  - NOT-DR3 disposition (single reason field, unchanged)
//  - STRUCTURED APPROVE: four required fields + equipment validation + variance gate,
//    all enforced server-side (client never trusted)
//  - Reject keeps its single note field

import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  requireApApprover,
  decideRequest,
  resolveDecisionSiteId,
  assertDecisionNote,
  ApNoteRequiredError,
  assertEquipmentForSite,
  ApEquipmentInvalidError,
  evaluateVarianceForDecision,
  ApDuplicateInvoiceError,
} = vi.hoisted(() => {
  class ApNoteRequiredError extends Error {}
  class ApEquipmentInvalidError extends Error {}
  class ApDuplicateInvoiceError extends Error {
    constructor(
      readonly invoiceNumber: string | null,
      readonly matches: {
        requestId: string;
        sameInvoiceNumber: boolean;
        sameFile: boolean;
        subject: string | null;
        vendor: string | null;
        amountCents: number | null;
        approvedAt: Date | null;
        approvedBy: string | null;
      }[],
      readonly approverNames: Map<string, string>,
    ) {
      super(`Invoice ${invoiceNumber} was already approved`);
    }
  }
  return {
    ApDuplicateInvoiceError,
    requireApApprover: vi.fn(async () => ({ userId: 'u-morena' })),
    decideRequest: vi.fn(async () => ({ requestId: 'req-1', decision: 'approved', mail: 'sent' })),
    resolveDecisionSiteId: vi.fn(async () => 'site-w'),
    assertDecisionNote: vi.fn((): void => undefined),
    ApNoteRequiredError,
    assertEquipmentForSite: vi.fn(async (): Promise<void> => undefined),
    ApEquipmentInvalidError,
    evaluateVarianceForDecision: vi.fn(async () => ({ state: 'not_applicable', evaluation: null })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ap/approvers', () => ({ requireApApprover }));
vi.mock('@/lib/ap/equipment', () => ({ assertEquipmentForSite, ApEquipmentInvalidError }));
vi.mock('@/lib/ap/variance', () => ({ evaluateVarianceForDecision }));
vi.mock('@/lib/ap/approvals', () => ({
  ApAlreadyDecidedError: class extends Error {},
  ApDuplicateInvoiceError,
  ApInvalidSiteError: class extends Error {},
  ApLocationConflictError: class extends Error {},
  ApNoteRequiredError,
  ApNotActionableError: class extends Error {},
  ApRequestNotFoundError: class extends Error {},
  ApSiteRequiredError: class extends Error {},
  assertDecisionNote,
  assertDecisionSite: () => undefined,
  decideRequest,
  resolveDecisionSiteId,
}));

import { POST } from './route';

function call(body: unknown, id = 'req-1'): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1:3000/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

// A complete, valid structured-Approve payload (no variance trip by default).
const APPROVE = {
  decision: 'approved',
  siteId: 'woodland',
  vendorFreeform: 'Sunbelt Rentals',
  explanation: 'mower rental for the Woodland yard',
  confirmedAmountCents: 12500,
  notEquipmentRelated: true,
} as const;

interface DecideArgShape {
  filedNotDr3?: boolean;
  siteId?: string;
  note?: string;
  vendorFreeform?: string;
  explanation?: string;
  confirmedAmountCents?: number;
  equipmentLinks?: { equipmentIds: string[]; notEquipmentRelated: boolean };
  varianceFlagState?: string;
  varianceAcknowledgedBy?: string;
  varianceAcknowledgmentNote?: string;
  duplicateOverrideReason?: string;
}
function lastDecideArg(): DecideArgShape {
  return (decideRequest.mock.calls.at(-1)! as unknown[])[0] as DecideArgShape;
}

beforeEach(() => {
  decideRequest.mockClear();
  resolveDecisionSiteId.mockClear();
  assertDecisionNote.mockReset();
  assertDecisionNote.mockImplementation((): void => undefined);
  assertEquipmentForSite.mockReset();
  assertEquipmentForSite.mockImplementation(async (): Promise<void> => undefined);
  evaluateVarianceForDecision.mockReset();
  evaluateVarianceForDecision.mockImplementation(async () => ({
    state: 'not_applicable',
    evaluation: null,
  }));
});

describe('POST /api/ops/ap/[id]/decide — free-text caps (F7-AP)', () => {
  it('400s an over-length note WITHOUT deciding the request', async () => {
    const res = await call({ decision: 'approved', note: 'x'.repeat(2001), siteId: 'woodland' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/note/i);
    expect(decideRequest).not.toHaveBeenCalled();
    expect(resolveDecisionSiteId).not.toHaveBeenCalled();
  });

  it('400s an over-length explanation WITHOUT deciding', async () => {
    const res = await call({ ...APPROVE, explanation: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/explanation/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s an over-length vendor WITHOUT deciding the request', async () => {
    const res = await call({ ...APPROVE, vendorFreeform: 'v'.repeat(201) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/vendor/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops/ap/[id]/decide — NOT DR3 disposition', () => {
  it('NOT DR3 with a reason: decides with filedNotDr3, never resolves a site', async () => {
    const res = await call({ decision: 'approved', notDr3: true, note: 'parent-org bill' });
    expect(res.status).toBe(200);
    expect(resolveDecisionSiteId).not.toHaveBeenCalled();
    const arg = lastDecideArg();
    expect(arg.filedNotDr3).toBe(true);
    expect(arg.siteId).toBeUndefined();
    expect(arg.note).toBe('parent-org bill');
  });

  it('400s NOT DR3 with no reason WITHOUT deciding', async () => {
    const res = await call({ decision: 'approved', notDr3: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/NOT DR3 requires a reason/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s when BOTH a site AND notDr3 are supplied (mutual exclusion)', async () => {
    const res = await call({ decision: 'approved', notDr3: true, siteId: 'woodland', note: 'r' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not both/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops/ap/[id]/decide — reject keeps its single note field', () => {
  it('rejects with a note + vendor at the cap boundary (proceeds to decide)', async () => {
    const res = await call({
      decision: 'rejected',
      note: 'x'.repeat(2000),
      vendor: 'v'.repeat(200),
      siteId: 'woodland',
    });
    expect(res.status).toBe(200);
    expect(assertDecisionNote).toHaveBeenCalledWith('rejected', 'x'.repeat(2000));
    expect(decideRequest).toHaveBeenCalledTimes(1);
    const arg = lastDecideArg();
    expect(arg.vendorFreeform).toBeUndefined(); // reject is NOT structured
    expect(arg.siteId).toBe('site-w');
  });

  it('400s a rejection whose note guard throws WITHOUT deciding', async () => {
    assertDecisionNote.mockImplementation((): void => {
      throw new ApNoteRequiredError('A rejection must include a note explaining why.');
    });
    const res = await call({ decision: 'rejected', siteId: 'woodland' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejection must include a note/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops/ap/[id]/decide — structured Approve (D-M5-1/6)', () => {
  it('happy path: decides with the structured fields + equipment linkage', async () => {
    const res = await call({
      decision: 'approved',
      siteId: 'woodland',
      vendorFreeform: 'Sunbelt Rentals',
      explanation: 'mower rental',
      confirmedAmountCents: 12500,
      equipmentIds: ['eq-1', 'eq-2'],
    });
    expect(res.status).toBe(200);
    expect(resolveDecisionSiteId).toHaveBeenCalledTimes(1);
    // Fleet-wide as of 2026-07-28 (operator directive overriding ADR-0046
    // Amendment 5 D-M5-6): the validator no longer receives a site id.
    expect(assertEquipmentForSite).toHaveBeenCalledWith(expect.anything(), ['eq-1', 'eq-2']);
    const arg = lastDecideArg();
    expect(arg.vendorFreeform).toBe('Sunbelt Rentals');
    expect(arg.explanation).toBe('mower rental');
    expect(arg.confirmedAmountCents).toBe(12500);
    expect(arg.equipmentLinks).toEqual({
      equipmentIds: ['eq-1', 'eq-2'],
      notEquipmentRelated: false,
    });
    expect(arg.siteId).toBe('site-w');
    // Structured Approve does NOT go through the single-note guard.
    expect(assertDecisionNote).not.toHaveBeenCalled();
  });

  it('"Not equipment-related" is accepted (no equipment validation call)', async () => {
    const res = await call(APPROVE);
    expect(res.status).toBe(200);
    expect(assertEquipmentForSite).not.toHaveBeenCalled();
    expect(lastDecideArg().equipmentLinks).toEqual({ equipmentIds: [], notEquipmentRelated: true });
  });

  it('400s a missing vendor', async () => {
    const res = await call({ ...APPROVE, vendorFreeform: '  ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/vendor name/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s a missing explanation', async () => {
    const res = await call({ ...APPROVE, explanation: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/explanation/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s a missing confirmed amount', async () => {
    const res = await call({ ...APPROVE, confirmedAmountCents: undefined });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/amount/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s when NEITHER equipment nor Not-equipment-related is chosen', async () => {
    const res = await call({ ...APPROVE, notEquipmentRelated: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/equipment/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s when BOTH equipment and Not-equipment-related are chosen', async () => {
    const res = await call({ ...APPROVE, notEquipmentRelated: true, equipmentIds: ['eq-1'] });
    expect(res.status).toBe(400);
    // Amendment 9 widened this from a pairwise "not both" to a three-way
    // "choose ONE" — the wording moved with the rule.
    expect((await res.json()).error).toMatch(/choose one/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s when equipment validation rejects an id (server trust boundary)', async () => {
    assertEquipmentForSite.mockImplementation(async () => {
      throw new ApEquipmentInvalidError('Selected equipment is not available for this site');
    });
    const res = await call({ ...APPROVE, notEquipmentRelated: false, equipmentIds: ['eq-x'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not available for this site/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});

// ── ADR-0046 Amendment 9 (§2.2) — the equipment ESCAPE HATCH ────────────────
//
// The hatch is the third mutually exclusive disposition. These cases exist
// because a three-way exclusive is exactly where a pairwise check silently rots:
// the failure mode is not a crash, it is an approval that writes TWO dispositions
// and trips a CHECK constraint in production, or ZERO and files against nothing.

describe('POST /api/ops/ap/[id]/decide — equipment escape hatch (Amendment 9)', () => {
  const APPROVE = {
    decision: 'approved',
    siteId: 'woodland',
    vendorFreeform: 'Acme Rentals',
    explanation: 'Forklift repair',
    confirmedAmountCents: 45_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    assertEquipmentForSite.mockImplementation(async () => undefined);
    evaluateVarianceForDecision.mockResolvedValue({ state: 'not_applicable', evaluation: null });
  });

  it('accepts a description alone and passes it through — no equipment validation', async () => {
    const res = await call({
      ...APPROVE,
      equipmentRequestDescription: '  Yellow Hyster forklift, unit 7, Woodland  ',
    });
    expect(res.status).toBe(200);
    // The hatch cites no registry id, so the id validator must NOT run.
    expect(assertEquipmentForSite).not.toHaveBeenCalled();
    expect(lastDecideArg().equipmentLinks).toEqual({
      equipmentIds: [],
      notEquipmentRelated: false,
      equipmentRequestDescription: 'Yellow Hyster forklift, unit 7, Woodland',
    });
  });

  it('a whitespace-only description does NOT satisfy the equipment requirement', async () => {
    // The hatch must never be the cheap way out. An empty description is the same
    // as choosing nothing at all.
    const res = await call({ ...APPROVE, equipmentRequestDescription: '   \n  ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/select the equipment/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s the hatch combined with an equipment selection', async () => {
    const res = await call({
      ...APPROVE,
      equipmentIds: ['eq-1'],
      equipmentRequestDescription: 'a forklift',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/choose one/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s the hatch combined with "Not equipment-related"', async () => {
    const res = await call({
      ...APPROVE,
      notEquipmentRelated: true,
      equipmentRequestDescription: 'a forklift',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/choose one/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s an over-long description (storage-DoS boundary) before any state change', async () => {
    const res = await call({ ...APPROVE, equipmentRequestDescription: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/2000 characters or fewer/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('still enforces the OTHER Amendment 5 requirements — the hatch waives nothing', async () => {
    const res = await call({
      ...APPROVE,
      explanation: '',
      equipmentRequestDescription: 'a forklift',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/explanation/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops/ap/[id]/decide — variance gate (D-M5-4)', () => {
  it('400s an above-threshold variance that is NOT acknowledged', async () => {
    evaluateVarianceForDecision.mockImplementation(async () => ({
      state: 'above_threshold',
      evaluation: null,
    }));
    const res = await call(APPROVE);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/variance/i);
    expect(body.varianceRequired).toBe(true);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('decides an above-threshold variance WHEN acknowledged (state → acknowledged)', async () => {
    evaluateVarianceForDecision.mockImplementation(async () => ({
      state: 'above_threshold',
      evaluation: null,
    }));
    const res = await call({
      ...APPROVE,
      varianceAcknowledged: true,
      varianceAckNote: 'confirmed with Morena',
    });
    expect(res.status).toBe(200);
    const arg = lastDecideArg();
    expect(arg.varianceFlagState).toBe('acknowledged');
    expect(arg.varianceAcknowledgedBy).toBe('u-morena');
    expect(arg.varianceAcknowledgmentNote).toBe('confirmed with Morena');
  });

  it('passes below_threshold straight through (no ack needed)', async () => {
    evaluateVarianceForDecision.mockImplementation(async () => ({
      state: 'below_threshold',
      evaluation: null,
    }));
    const res = await call(APPROVE);
    expect(res.status).toBe(200);
    expect(lastDecideArg().varianceFlagState).toBe('below_threshold');
  });
});

describe('POST /api/ops/ap/[id]/decide — already-approved invoice (ADR-0136)', () => {
  it('a same-file match on ANOTHER number does not report this request’s number (13423 carrying 13422’s PDF)', async () => {
    decideRequest.mockImplementationOnce(async () => {
      throw new ApDuplicateInvoiceError(
        '13423',
        [
          {
            requestId: 'x13422',
            sameInvoiceNumber: false,
            sameFile: true,
            subject: 'FW: New payment request from Xtraction, Inc. - invoice 13422',
            vendor: 'Xtraction',
            amountCents: 54810,
            approvedAt: new Date('2026-09-21T20:00:00Z'),
            approvedBy: 'u-janette',
          },
        ],
        new Map(),
      );
    });
    const res = await call(APPROVE);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      duplicateInvoice: { invoiceNumber: string | null; matches: { sameFile: boolean }[] };
    };
    expect(body.duplicateInvoice.invoiceNumber).toBeNull();
    expect(body.duplicateInvoice.matches[0]!.sameFile).toBe(true);
  });

  it('409s with the matches the UI needs to render the banner', async () => {
    decideRequest.mockImplementationOnce(async () => {
      throw new ApDuplicateInvoiceError(
        '6646',
        [
          {
            requestId: 'first',
            sameInvoiceNumber: true,
            sameFile: false,
            subject: 'FW: Invoice: 6646',
            vendor: 'United',
            amountCents: 20184,
            approvedAt: new Date('2026-08-13T12:32:37Z'),
            approvedBy: 'u-morena',
          },
        ],
        new Map([['u-morena', 'Morena Gomez']]),
      );
    });
    const res = await call(APPROVE);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; duplicateInvoice: unknown };
    expect(body.error).toContain('Invoice 6646 was already approved');
    expect(body.duplicateInvoice).toEqual({
      invoiceNumber: '6646',
      matches: [
        {
          requestId: 'first',
          sameFile: false,
          subject: 'FW: Invoice: 6646',
          vendor: 'United',
          amountCents: 20184,
          approvedAt: '2026-08-13T12:32:37.000Z',
          approvedBy: 'Morena Gomez',
        },
      ],
    });
  });

  it('passes a trimmed override reason through to the decision', async () => {
    const res = await call({
      ...APPROVE,
      duplicateOverrideReason: '  AP re-sent to fix the note ',
    });
    expect(res.status).toBe(200);
    expect(lastDecideArg().duplicateOverrideReason).toBe('AP re-sent to fix the note');
  });

  it('omits a blank reason (the lib then refuses a real duplicate)', async () => {
    await call({ ...APPROVE, duplicateOverrideReason: '   ' });
    expect(lastDecideArg().duplicateOverrideReason).toBeUndefined();
  });

  it('400s an over-length reason WITHOUT deciding', async () => {
    const res = await call({ ...APPROVE, duplicateOverrideReason: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});
