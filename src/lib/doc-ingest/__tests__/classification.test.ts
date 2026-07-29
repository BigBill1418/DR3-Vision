// ADR-0067 §3.2 D5 — classify once, confirm once, then LOCKED.
//
// The DO-NOT under test: "Once he confirms, the kind is registered and stable;
// never re-ask." These tests make that mechanical rather than aspirational.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifySourceIfNeeded,
  confirmClassification,
  reclassifySource,
  setSourceEnabled,
} from '../classification';
import { VENDOR_INVOICE_CORRECT_ADDRESS } from '../classifier';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
import { writeAudit } from '@/lib/audit';

const NOW = new Date('2026-07-29T12:00:00.000Z');

let prisma: FakeDocIngestPrisma;
const p = () => prisma as unknown as never;

beforeEach(() => {
  resetFakeIds();
  prisma = makeFakePrisma();
  vi.mocked(writeAudit).mockClear();
});

async function seedSource(over: Record<string, unknown> = {}) {
  return (await prisma.docSource.create({
    data: {
      drive_id: 'drive-A',
      item_id: 'item-1',
      display_name: 'JULY 2026 DAILY LOG.xlsm',
      ...over,
    },
  })) as unknown as Parameters<typeof classifySourceIfNeeded>[1];
}

const openAnomalies = (kind?: string) =>
  prisma._stores.anomalies.filter(
    (a) => a['status'] === 'open' && (kind === undefined || a['kind'] === kind),
  );

describe('classifySourceIfNeeded', () => {
  it('writes a PROPOSAL and leaves doc_class NULL — nothing is registered without a human', async () => {
    const source = await seedSource();
    const done = await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);

    expect(done).toBe(true);
    const row = prisma._stores.sources[0];
    expect(row?.['proposed_class']).toBe('daily_log_workbook');
    // The proposal is not a decision.
    expect(row?.['doc_class']).toBeNull();
    expect(row?.['classification_attempted_at']).toEqual(NOW);
  });

  it('NEVER re-classifies a registered source — the explicit DO-NOT', async () => {
    const source = await seedSource({ doc_class: 'daily_log_workbook' });
    const done = await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);
    expect(done).toBe(false);
    // Not even a proposal is written — there is nothing to ask about.
    expect(prisma._stores.sources[0]?.['proposed_class']).toBeNull();
  });

  it('queues an `unclassified` anomaly for an unrecognized document, and does NOT page', async () => {
    const source = await seedSource({ display_name: 'random notes.txt' });
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);

    const anomaly = openAnomalies('unclassified')[0];
    expect(anomaly).toBeDefined();
    // Graceful: it waits for him rather than erroring or guessing wildly.
    expect(String(anomaly?.['detail'])).toContain('waiting for confirmation');
    expect(String(anomaly?.['detail'])).toContain('Nothing is ingested');
  });

  it('FLAGS a misdirected vendor invoice and states the correct address', async () => {
    const source = await seedSource({
      display_name: 'Acme Invoice 4432.pdf',
      owner_upn: 'kelsey@svdp.us',
    });
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);

    const anomaly = openAnomalies('misdirected_document')[0];
    expect(anomaly).toBeDefined();
    expect(String(anomaly?.['detail'])).toContain(VENDOR_INVOICE_CORRECT_ADDRESS);
    expect(String(anomaly?.['detail'])).toContain('NOT routed by document ingestion');
    // And nothing is ingested from it.
    expect(String(anomaly?.['detail'])).toContain('Nothing has been ingested');
  });

  it('leaves the proposed site NULL when the detected name matches no real site', async () => {
    // Hard rule #2 — a NULL site means UNCLASSIFIED, never a guess.
    const source = await seedSource({ display_name: 'Portland Daily Log.xlsm' });
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);
    expect(prisma._stores.sources[0]?.['proposed_site_id']).toBeNull();
  });

  it('resolves a detected site NAME to a real site id', async () => {
    await prisma.site.create({ data: { id: 'site-eugene', name: 'Eugene' } });
    const source = await seedSource({ display_name: 'Eugene Daily Log 2026-07.xlsm' });
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);
    expect(prisma._stores.sources[0]?.['proposed_site_id']).toBe('site-eugene');
    expect(prisma._stores.sources[0]?.['proposed_period']).toBe('2026-07');
  });
});

describe('confirmClassification — the registering act', () => {
  it('registers the kind, scopes the site, and audits the decision', async () => {
    const source = await seedSource();
    await confirmClassification(p(), {
      sourceId: source.id,
      kind: 'daily_log_workbook',
      siteId: 'site-eugene',
      period: '2026-07',
      actorUserId: 'user-1',
      now: NOW,
    });

    const row = prisma._stores.sources[0];
    expect(row?.['doc_class']).toBe('daily_log_workbook');
    expect(row?.['doc_class_source']).toBe('operator');
    expect(row?.['site_id']).toBe('site-eugene');
    expect(row?.['classified_by']).toBe('user-1');
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('REFUSES to silently overwrite an already-registered kind', async () => {
    const source = await seedSource({ doc_class: 'daily_log_workbook' });
    await expect(
      confirmClassification(p(), {
        sourceId: source.id,
        kind: 'rate_table',
        siteId: null,
        period: null,
        actorUserId: 'user-1',
        now: NOW,
      }),
    ).rejects.toThrow(/already registered/);
    // A stray double-submit must never re-register a document under a different
    // kind — that would change what downstream code does with it, untraceably.
    expect(prisma._stores.sources[0]?.['doc_class']).toBe('daily_log_workbook');
  });

  it('resolves the unclassified queue item once confirmed', async () => {
    const source = await seedSource({ display_name: 'random notes.txt' });
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);
    expect(openAnomalies('unclassified')).toHaveLength(1);

    await confirmClassification(p(), {
      sourceId: source.id,
      kind: 'rate_table',
      siteId: null,
      period: null,
      actorUserId: 'user-1',
      now: NOW,
    });
    expect(openAnomalies('unclassified')).toHaveLength(0);
  });
});

describe('reclassifySource — the deliberate correction path', () => {
  it('changes a registered kind and records WHY', async () => {
    const source = await seedSource({ doc_class: 'daily_log_workbook' });
    await reclassifySource(p(), {
      sourceId: source.id,
      kind: 'rate_table',
      siteId: null,
      period: null,
      actorUserId: 'user-1',
      reason: 'structure changed materially — it is a rate table now',
      now: NOW,
    });

    expect(prisma._stores.sources[0]?.['doc_class']).toBe('rate_table');
    const audit = vi.mocked(writeAudit).mock.calls[0]?.[0];
    expect(audit?.before).toMatchObject({ doc_class: 'daily_log_workbook' });
    expect(audit?.after).toMatchObject({ reason: expect.stringContaining('structure changed') });
  });
});

describe('setSourceEnabled — Bill’s kill switch', () => {
  it('flips `enabled` without touching `state`, and audits it', async () => {
    const source = await seedSource({ state: 'active' });
    await setSourceEnabled(p(), source.id, false, 'user-1', NOW);

    const row = prisma._stores.sources[0];
    expect(row?.['enabled']).toBe(false);
    // `state` is what Microsoft says; `enabled` is what Bill says. Never conflated.
    expect(row?.['state']).toBe('active');
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });
});
