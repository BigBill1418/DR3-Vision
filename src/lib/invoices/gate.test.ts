import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { evaluateWindowGate, InvoiceGateBlockedError } from './gate';

interface FakeOpts {
  findings?: Array<{
    id: string;
    check_code: string;
    severity: string;
    status: string;
    first_detected_at?: Date;
  }>;
  override?: boolean;
}

const OVERRIDE_AT = new Date('2026-07-01T00:00:00Z');
const BEFORE_OVERRIDE = new Date('2026-06-20T00:00:00Z');
const AFTER_OVERRIDE = new Date('2026-07-05T00:00:00Z');

function fakeDb(opts: FakeOpts = {}): PrismaClient {
  return {
    auditFinding: {
      // first_detected_at defaults to BEFORE the override so the historical
      // tests keep their pre-scoping semantics (override covers the finding).
      findMany: vi.fn(async () =>
        (opts.findings ?? []).map((f) => ({ first_detected_at: BEFORE_OVERRIDE, ...f })),
      ),
    },
    auditCheckConfig: { findMany: vi.fn(async () => []) }, // no rows → seeded defaults apply
    auditLog: {
      findFirst: vi.fn(async () =>
        opts.override ? { id: 'ovr1', created_at: OVERRIDE_AT } : null,
      ),
    },
  } as unknown as PrismaClient;
}

const W = ['2026-06-01', '2026-06-30'] as const;

describe('evaluateWindowGate', () => {
  it('clean window → not blocked, not overridden', async () => {
    const r = await evaluateWindowGate(fakeDb(), 'site1', W[0], W[1]);
    expect(r.blocked).toBe(false);
    expect(r.overridden).toBe(false);
    expect(r.findingCodes).toEqual([]);
  });

  it('open high-severity finding on a blocking check → blocked with codes', async () => {
    const r = await evaluateWindowGate(
      fakeDb({
        findings: [
          { id: 'f1', check_code: 'c4_billing_basis', severity: 'critical', status: 'open' },
        ],
      }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(true);
    expect(r.findingCodes).toContain('c4_billing_basis');
  });

  it('an override for the exact window unblocks but records overridden=true', async () => {
    const r = await evaluateWindowGate(
      fakeDb({
        findings: [
          { id: 'f1', check_code: 'c4_billing_basis', severity: 'critical', status: 'open' },
        ],
        override: true,
      }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(false);
    expect(r.overridden).toBe(true);
    expect(r.findingCodes).toContain('c4_billing_basis'); // still surfaced for audit
  });

  it('a blocking finding FIRST DETECTED after the override re-blocks (no permanent skeleton key)', async () => {
    const r = await evaluateWindowGate(
      fakeDb({
        findings: [
          {
            id: 'f-new',
            check_code: 'c4_billing_basis',
            severity: 'critical',
            status: 'open',
            first_detected_at: AFTER_OVERRIDE,
          },
        ],
        override: true,
      }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(true); // the old override does not cover the new finding
    expect(r.overridden).toBe(false);
  });

  it('a resolved finding never blocks', async () => {
    const r = await evaluateWindowGate(
      fakeDb({
        findings: [
          { id: 'f1', check_code: 'c4_billing_basis', severity: 'critical', status: 'resolved' },
        ],
      }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(false);
  });
});

describe('InvoiceGateBlockedError', () => {
  it('carries the finding codes in context', () => {
    const e = new InvoiceGateBlockedError({
      siteId: 's',
      windowStartISO: W[0],
      windowEndISO: W[1],
      findingCodes: ['c4_billing_basis'],
    });
    expect(e.status).toBe(409);
    expect(e.context.findingCodes).toEqual(['c4_billing_basis']);
  });
});
