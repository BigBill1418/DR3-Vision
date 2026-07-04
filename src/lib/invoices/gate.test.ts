import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { evaluateWindowGate, InvoiceGateBlockedError } from './gate';

interface FakeOpts {
  findings?: Array<{ id: string; check_code: string; severity: string; status: string }>;
  override?: boolean;
}

function fakeDb(opts: FakeOpts = {}): PrismaClient {
  return {
    auditFinding: { findMany: vi.fn(async () => opts.findings ?? []) },
    auditCheckConfig: { findMany: vi.fn(async () => []) }, // no rows → seeded defaults apply
    auditLog: { findFirst: vi.fn(async () => (opts.override ? { id: 'ovr1' } : null)) },
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
      fakeDb({ findings: [{ id: 'f1', check_code: 'c4_billing_basis', severity: 'critical', status: 'open' }] }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(true);
    expect(r.findingCodes).toContain('c4_billing_basis');
  });

  it('an override for the exact window unblocks but records overridden=true', async () => {
    const r = await evaluateWindowGate(
      fakeDb({ findings: [{ id: 'f1', check_code: 'c4_billing_basis', severity: 'critical', status: 'open' }], override: true }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(false);
    expect(r.overridden).toBe(true);
    expect(r.findingCodes).toContain('c4_billing_basis'); // still surfaced for audit
  });

  it('a resolved finding never blocks', async () => {
    const r = await evaluateWindowGate(
      fakeDb({ findings: [{ id: 'f1', check_code: 'c4_billing_basis', severity: 'critical', status: 'resolved' }] }),
      'site1',
      W[0],
      W[1],
    );
    expect(r.blocked).toBe(false);
  });
});

describe('InvoiceGateBlockedError', () => {
  it('carries the finding codes in context', () => {
    const e = new InvoiceGateBlockedError({ siteId: 's', windowStartISO: W[0], windowEndISO: W[1], findingCodes: ['c4_billing_basis'] });
    expect(e.status).toBe(409);
    expect(e.context.findingCodes).toEqual(['c4_billing_basis']);
  });
});
