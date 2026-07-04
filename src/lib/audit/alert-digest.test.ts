import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
const siteFindMany = vi.fn();
const logFindUnique = vi.fn();
const logCreate = vi.fn();
const findingFindMany = vi.fn();
const recipientFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findMany: (...a: unknown[]) => siteFindMany(...a) },
    alertDigestLog: {
      findUnique: (...a: unknown[]) => logFindUnique(...a),
      create: (...a: unknown[]) => logCreate(...a),
    },
    auditFinding: { findMany: (...a: unknown[]) => findingFindMany(...a) },
    alertRecipient: { findMany: (...a: unknown[]) => recipientFindMany(...a) },
  },
}));

const sendSystemEmail = vi.fn();
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...a) }));

const publishNtfy = vi.fn();
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...a) }));

const DAY_KEY = new Date(Date.UTC(2026, 6, 4)); // 2026-07-04
vi.mock('@/lib/time', () => ({ appToday: () => DAY_KEY }));

vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runAlertDigestFire, renderDigestHtml } from './alert-digest';

const SITE = { id: 'site-w', code: 'woodland', name: 'Woodland' };
const NOW = new Date('2026-07-04T01:00:00Z');

function findingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    check_code: 'r1_recycling_rate',
    severity: 'high',
    window_start: new Date('2025-10-04T00:00:00Z'),
    window_end: new Date('2026-07-04T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  siteFindMany.mockResolvedValue([SITE]);
  logFindUnique.mockResolvedValue(null);
  logCreate.mockResolvedValue({ id: 'log1' });
  findingFindMany.mockResolvedValue([findingRow()]);
  recipientFindMany.mockResolvedValue([{ email: 'morena.gomez@svdp.us' }, { email: 'janette.tomas@svdp.us' }]);
  sendSystemEmail.mockResolvedValue({ delivered: true, disabled: false, messageId: 'm-1', retries: 0, lastStatus: undefined });
  publishNtfy.mockResolvedValue({ ok: true, outcome: 'sent' });
});

describe('runAlertDigestFire', () => {
  it('sends one digest per site with open findings, logs it, and never pages on success', async () => {
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes).toEqual([
      { siteCode: 'woodland', status: 'sent', findingCount: 1, delivered: 2, attempted: 2 },
    ]);
    expect(sendSystemEmail).toHaveBeenCalledTimes(2); // per-recipient
    expect(logCreate).toHaveBeenCalledTimes(1);
    expect(logCreate.mock.calls[0]![0].data).toMatchObject({
      site_id: 'site-w',
      digest_date: DAY_KEY,
      finding_count: 1,
      recipient_count: 2,
      delivered_count: 2,
    });
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('skips when there are no open R/M findings (no email, no log)', async () => {
    findingFindMany.mockResolvedValue([]);
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]).toEqual({ siteCode: 'woodland', status: 'skipped_no_findings' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(logCreate).not.toHaveBeenCalled();
  });

  it('is idempotent — a same-day re-fire is skipped via the digest log', async () => {
    logFindUnique.mockResolvedValue({ id: 'existing' });
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]).toEqual({ siteCode: 'woodland', status: 'skipped_already_logged' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('skips when the site has no active recipients', async () => {
    recipientFindMany.mockResolvedValue([]);
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]).toEqual({ siteCode: 'woodland', status: 'skipped_no_recipients' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('fail-open when M365 is disabled — no log write, no page', async () => {
    sendSystemEmail.mockResolvedValue({ delivered: false, disabled: true, messageId: 'm', retries: 0, lastStatus: undefined });
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]).toEqual({ siteCode: 'woodland', status: 'disabled', findingCount: 1 });
    expect(logCreate).not.toHaveBeenCalled();
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('pages dr3-vision-system (fingerprinted) when delivery fails to every recipient', async () => {
    sendSystemEmail.mockResolvedValue({ delivered: false, disabled: false, messageId: 'm', retries: 5, lastStatus: 503 });
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]!.status).toBe('failed');
    expect(logCreate).toHaveBeenCalledTimes(1); // attempt still ledgered (idempotency)
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    expect(publishNtfy.mock.calls[0]![0]).toMatchObject({
      topic: 'dr3-vision-system',
      fingerprint: 'alert-digest-failed:woodland',
      priority: 'high',
    });
  });

  it('one site throwing never stops the others', async () => {
    siteFindMany.mockResolvedValue([SITE, { id: 'site-e', code: 'eugene', name: 'Eugene' }]);
    findingFindMany.mockRejectedValueOnce(new Error('db blip')); // first site throws
    const { outcomes } = await runAlertDigestFire(NOW);
    // Only the second site produced an outcome (the first was caught + skipped).
    expect(outcomes.map((o) => o.siteCode)).toEqual(['eugene']);
  });
});

describe('renderDigestHtml', () => {
  it('lists findings with links to the site audit surface', () => {
    const html = renderDigestHtml(SITE, [
      { id: 'f1', checkCode: 'r1_recycling_rate', severity: 'high', windowStartISO: '2025-10-04', windowEndISO: '2026-07-04' },
      { id: 'f2', checkCode: 'm2_missing_snapshot', severity: 'medium', windowStartISO: '2026-06-01', windowEndISO: '2026-07-04' },
    ]);
    expect(html).toContain('/dashboard/woodland/audit');
    expect(html).toContain('Recycling rate below contract floor');
    expect(html).toContain('Missing physical snapshot');
    expect(html).toContain('check=r1_recycling_rate');
  });
});
