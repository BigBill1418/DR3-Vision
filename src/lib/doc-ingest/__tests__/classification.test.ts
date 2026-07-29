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

/**
 * Seed a source AND the version row that carries its parsed content.
 *
 * The version is not incidental: as of 2026-07-29 `classifySourceIfNeeded`
 * refuses to classify a `file` source that has none, because classifying a
 * document nobody has read yet is what produced "the workbook is completely
 * empty" about a 40-sheet, 2,117-row workbook. Pass `{ withVersion: false }` to
 * exercise that guard.
 */
async function seedSource(
  over: Record<string, unknown> = {},
  opts: { withVersion?: boolean } = {},
) {
  const source = (await prisma.docSource.create({
    data: {
      drive_id: 'drive-A',
      item_id: 'item-1',
      display_name: 'JULY 2026 DAILY LOG.xlsm',
      kind: 'file',
      ...over,
    },
  })) as unknown as Parameters<typeof classifySourceIfNeeded>[1];

  if (opts.withVersion !== false) {
    await prisma.docSourceVersion.create({
      data: {
        doc_source_id: source.id,
        ctag: 'ctag-1',
        content_sha256: 'sha-1',
        observed_at: new Date(NOW.getTime() - 1_000),
        parse_summary: null,
      },
    });
  }
  return source;
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

  // ── REGRESSION 2026-07-29 — classifying a document nobody has read ────────
  it('REFUSES to classify a file that has not been fetched yet', async () => {
    // Live symptom: TEREX.xlsx was proposed `unknown` (0.1) with the reasoning
    // "the workbook is completely empty", while its own stored parse summary
    // recorded 40 sheets and 2,117 rows. The classifier was handed nothing and
    // described nothing, faithfully. Deferring is the only honest answer.
    const source = await seedSource({}, { withVersion: false });
    const done = await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);

    expect(done).toBe(false);
    expect(prisma._stores.sources[0]?.['proposed_class']).toBeNull();
    expect(prisma._stores.sources[0]?.['classification_attempted_at']).toBeNull();
    // And it did not invent an anomaly about an emptiness it never observed.
    expect(openAnomalies('unclassified')).toHaveLength(0);
  });

  it('still classifies a FOLDER, which never has a version row', async () => {
    const source = await seedSource(
      { kind: 'folder', display_name: 'Daily Logs 2026' },
      { withVersion: false },
    );
    const done = await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);
    expect(done).toBe(true);
  });

  it('does not re-ask a settled proposal every sweep', async () => {
    // ~96 Claude calls/day per unclassified document, each silently overwriting
    // the last proposal. A proposal goes stale only when new content lands.
    const source = await seedSource();
    expect(await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW)).toBe(
      true,
    );

    const again = (await prisma.docSource.findUnique({
      where: { id: source.id },
    })) as unknown as Parameters<typeof classifySourceIfNeeded>[1];
    expect(await classifySourceIfNeeded(p(), again, { fallbackEnabled: () => false }, NOW)).toBe(
      false,
    );
  });

  it('DOES re-classify once new content lands', async () => {
    const source = await seedSource();
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);

    await prisma.docSourceVersion.create({
      data: {
        doc_source_id: source.id,
        ctag: 'ctag-2',
        content_sha256: 'sha-2',
        observed_at: new Date(NOW.getTime() + 60_000),
        parse_summary: null,
      },
    });

    const again = (await prisma.docSource.findUnique({
      where: { id: source.id },
    })) as unknown as Parameters<typeof classifySourceIfNeeded>[1];
    expect(await classifySourceIfNeeded(p(), again, { fallbackEnabled: () => false }, NOW)).toBe(
      true,
    );
  });

  it('RESOLVES a stale `unclassified` anomaly once a real kind is proposed', async () => {
    // The live failure: the source said `equipment_inventory` while an open
    // anomaly still asserted the file was empty. Two surfaces disagreeing about
    // the same document, with nothing to reconcile them — `confirmClassification`
    // only fires when Bill confirms, which he will not do while the surface tells
    // him the file is empty.
    const source = await seedSource({ display_name: 'random notes.txt' });
    await classifySourceIfNeeded(p(), source, { fallbackEnabled: () => false }, NOW);
    expect(openAnomalies('unclassified')).toHaveLength(1);

    await prisma.docSource.update({
      where: { id: source.id },
      data: { display_name: 'JULY 2026 DAILY LOG.xlsm' },
    });
    await prisma.docSourceVersion.create({
      data: {
        doc_source_id: source.id,
        ctag: 'ctag-2',
        content_sha256: 'sha-2',
        observed_at: new Date(NOW.getTime() + 60_000),
        parse_summary: null,
      },
    });
    const again = (await prisma.docSource.findUnique({
      where: { id: source.id },
    })) as unknown as Parameters<typeof classifySourceIfNeeded>[1];

    expect(await classifySourceIfNeeded(p(), again, { fallbackEnabled: () => false }, NOW)).toBe(
      true,
    );
    expect(prisma._stores.sources[0]?.['proposed_class']).toBe('daily_log_workbook');
    expect(openAnomalies('unclassified')).toHaveLength(0);
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
