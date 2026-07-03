import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { gateForWindow, recordGateOverride, type GateFinding } from './billing-gate';
import { defaultCheckConfigMap } from './config';

const configs = defaultCheckConfigMap(); // c4 min_blocking_severity = 'high'

function gf(over: Partial<GateFinding> = {}): GateFinding {
  return { id: 'f1', checkCode: 'c1_inbound', severity: 'high', status: 'open', ...over };
}

describe('gateForWindow', () => {
  it('clean window → not blocked', () => {
    const r = gateForWindow([], configs);
    expect(r.blocked).toBe(false);
    expect(r.minBlockingSeverity).toBe('high');
  });

  it('an open high-severity finding on a blocking check → blocked', () => {
    expect(gateForWindow([gf({ severity: 'high' })], configs).blocked).toBe(true);
    expect(gateForWindow([gf({ severity: 'critical' })], configs).blocked).toBe(true);
  });

  it('below-threshold severity does not block', () => {
    expect(gateForWindow([gf({ severity: 'low' })], configs).blocked).toBe(false);
    expect(gateForWindow([gf({ severity: 'medium' })], configs).blocked).toBe(false);
  });

  it('resolved / not_an_issue findings never block', () => {
    expect(gateForWindow([gf({ severity: 'critical', status: 'resolved' })], configs).blocked).toBe(false);
    expect(gateForWindow([gf({ severity: 'critical', status: 'not_an_issue' })], configs).blocked).toBe(false);
  });

  it('acknowledged still blocks (not yet resolved)', () => {
    expect(gateForWindow([gf({ severity: 'high', status: 'acknowledged' })], configs).blocked).toBe(true);
  });

  it('a check with blocksBilling=false does not contribute (c6, c7)', () => {
    expect(gateForWindow([gf({ checkCode: 'c6_inventory_continuity', severity: 'critical' })], configs).blocked).toBe(false);
    expect(gateForWindow([gf({ checkCode: 'c7_deadline', severity: 'critical' })], configs).blocked).toBe(false);
  });
});

describe('recordGateOverride', () => {
  it('requires a justification', async () => {
    const db = { auditLog: { create: vi.fn() } } as unknown as PrismaClient;
    const r = await recordGateOverride({
      db,
      siteId: 's',
      windowStartISO: '2026-06-01',
      windowEndISO: '2026-06-16',
      actorUserId: 'u1',
      justification: '   ',
    });
    expect(r).toEqual({ ok: false, reason: 'justification_required' });
  });

  it('writes an append-only audit_log override row', async () => {
    const create = vi.fn(async (arg: { data: { after: { override: boolean } } }) => {
      void arg;
      return {};
    });
    const db = { auditLog: { create } } as unknown as PrismaClient;
    const r = await recordGateOverride({
      db,
      siteId: 's',
      windowStartISO: '2026-06-01',
      windowEndISO: '2026-06-16',
      actorUserId: 'u1',
      justification: 'vendor invoice confirmed offline',
    });
    expect(r).toEqual({ ok: true });
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0]![0];
    expect(arg.data.after.override).toBe(true);
  });
});
