import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const digestFindUnique = vi.fn();
const digestCreate = vi.fn();
const digestUpdate = vi.fn();
const puFindMany = vi.fn();
const puCount = vi.fn();
const dropFindMany = vi.fn();
const outFindMany = vi.fn();
const findingCount = vi.fn();
const taskFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    updateDigest: {
      findUnique: (...a: unknown[]) => digestFindUnique(...a),
      create: (...a: unknown[]) => digestCreate(...a),
      update: (...a: unknown[]) => digestUpdate(...a),
    },
    processedUnitsDaily: {
      findMany: (...a: unknown[]) => puFindMany(...a),
      count: (...a: unknown[]) => puCount(...a),
    },
    consumerDropoff: { findMany: (...a: unknown[]) => dropFindMany(...a) },
    outboundMaterial: { findMany: (...a: unknown[]) => outFindMany(...a) },
    auditFinding: { count: (...a: unknown[]) => findingCount(...a) },
    opsTask: { findMany: (...a: unknown[]) => taskFindMany(...a) },
  },
}));

const writeAudit = vi.fn();
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  composeWeeklyMarkdown,
  finalizeDigest,
  generateWeeklyDraft,
  mdToHtml,
  renderDigestHtml,
  saveDigestBody,
  UpdateDigestError,
} from './update-digest';
import { absentEquipmentProvider } from './equipment-provider';

const MON = new Date(Date.UTC(2026, 6, 6)); // 2026-07-06 Monday
const SITES = [{ id: 'w', code: 'woodland', name: 'Woodland' }];

beforeEach(() => {
  vi.clearAllMocks();
  puFindMany.mockResolvedValue([]);
  puCount.mockResolvedValue(0);
  dropFindMany.mockResolvedValue([]);
  outFindMany.mockResolvedValue([]);
  findingCount.mockResolvedValue(0);
  taskFindMany.mockResolvedValue([]);
});

describe('composeWeeklyMarkdown (pure)', () => {
  it('lists per-site production/movement/findings/tasks and notes absent equipment', () => {
    const md = composeWeeklyMarkdown(
      '2026-06-29',
      '2026-07-05',
      [
        {
          code: 'woodland',
          name: 'Woodland',
          produced: 152.5,
          inboundUnits: 40,
          outboundWholeUnits: 12,
          outboundWeightLbs: 3400,
          openFindings: 2,
          completedTasks: ['Fix baler', 'Call MRC'],
        },
      ],
      false, // equipment unavailable
    );
    expect(md).toContain('# DR3 Updates — week of 2026-06-29 to 2026-07-05');
    expect(md).toContain('## Woodland');
    expect(md).toContain('Processed units: 152.5');
    expect(md).toContain('Open audit findings: 2');
    expect(md).toContain('Fix baler');
    expect(md).toContain('Equipment events unavailable');
  });
});

describe('generateWeeklyDraft — idempotent per (kind, period_start)', () => {
  it('creates a draft when none exists for the period', async () => {
    digestFindUnique.mockResolvedValue(null);
    digestCreate.mockResolvedValue({ id: 'd1' });
    const status = await generateWeeklyDraft(SITES, MON, absentEquipmentProvider);
    expect(status).toBe('created');
    expect(digestCreate.mock.calls[0]![0].data).toMatchObject({ kind: 'weekly', status: 'draft', generated_by: 'system:update-digest' });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'update_digests', action: 'insert' }),
    );
  });

  it('is a no-op when a draft already exists (never clobbers human edits)', async () => {
    digestFindUnique.mockResolvedValue({ id: 'existing' });
    const status = await generateWeeklyDraft(SITES, MON, absentEquipmentProvider);
    expect(status).toBe('exists');
    expect(digestCreate).not.toHaveBeenCalled();
    // no gathering work either
    expect(puFindMany).not.toHaveBeenCalled();
  });
});

describe('finalizeDigest / saveDigestBody', () => {
  it('finalize records finalized_by + audits; re-finalize is 409', async () => {
    digestFindUnique.mockResolvedValueOnce({ id: 'd1', status: 'draft' });
    digestUpdate.mockResolvedValue({ id: 'd1', status: 'finalized' });
    await finalizeDigest('d1', 'u1');
    expect(digestUpdate.mock.calls[0]![0].data).toMatchObject({ status: 'finalized', finalized_by: 'u1' });

    digestFindUnique.mockResolvedValueOnce({ id: 'd1', status: 'finalized' });
    await expect(finalizeDigest('d1', 'u1')).rejects.toBeInstanceOf(UpdateDigestError);
  });

  it('saveDigestBody rejects editing a finalized digest (409)', async () => {
    digestFindUnique.mockResolvedValue({ id: 'd1', status: 'finalized', body_md: 'x' });
    await expect(saveDigestBody('d1', 'new', 'u1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('mdToHtml / renderDigestHtml', () => {
  it('escapes html and renders headings + bullets in DR3 green', () => {
    const html = mdToHtml('# Title <script>\n- item **bold**');
    expect(html).toContain('#00524C'); // DR3 green
    expect(html).toContain('&lt;script&gt;'); // escaped
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li');
  });
  it('renderDigestHtml wraps the body in a DR3-branded shell', () => {
    const html = renderDigestHtml({ body_md: '# Hi' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('#00524C');
  });
});

describe('LOCKED DISPOSITION — the digest module has NO mail path', () => {
  it('never references sendSystemEmail / m365-mail (Vision never sends this digest)', () => {
    const src = readFileSync(fileURLToPath(new URL('./update-digest.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/sendSystemEmail/);
    expect(src).not.toMatch(/m365-mail/);
  });
});
