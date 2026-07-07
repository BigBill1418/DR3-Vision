import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
const siteFindMany = vi.fn();
const logFindUnique = vi.fn();
const logCreate = vi.fn();
const findingFindMany = vi.fn();
const recipientFindMany = vi.fn();
const opsTaskFindMany = vi.fn();
const apRequestCount = vi.fn(async () => 0);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findMany: (...a: unknown[]) => siteFindMany(...a) },
    alertDigestLog: {
      findUnique: (...a: unknown[]) => logFindUnique(...a),
      create: (...a: unknown[]) => logCreate(...a),
    },
    auditFinding: { findMany: (...a: unknown[]) => findingFindMany(...a) },
    alertRecipient: { findMany: (...a: unknown[]) => recipientFindMany(...a) },
    opsTask: { findMany: (...a: unknown[]) => opsTaskFindMany(...a) },
    // ADR-0046 D4 — the digest now reads the org-wide pending-AP count.
    apRequest: { count: () => apRequestCount() },
  },
}));

const sendSystemEmail = vi.fn();
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...a) }));

// ADR-0047 — the digest routes through notifyStaff(). Mock it as a live-mode
// pass-through to the (mocked) transport so the roster-recipient behaviour +
// outcome assertions below are unchanged; the rollout gate itself is covered by
// src/lib/notify/__tests__.
type MockSend = { delivered: boolean; disabled: boolean; messageId: string; lastStatus: number | undefined };
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: {
    recipients: ReadonlyArray<string | { address: string; name?: string }>;
    subject: string;
    htmlBody: string;
    fromDisplayName?: string;
    site: { id: string; code?: string } | null;
    surfaceCode: string;
  }) => {
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    const sends: MockSend[] = [];
    for (const to of recips) {
      sends.push(
        (await sendSystemEmail({
          to,
          subject: args.subject,
          htmlBody: args.htmlBody,
          fromDisplayName: args.fromDisplayName,
        })) as MockSend,
      );
    }
    const disabled = sends.length > 0 && sends.every((s) => s.disabled);
    const delivered = sends.filter((s) => s.delivered).length;
    return {
      mode: 'live' as const,
      disabled,
      delivered,
      actualRecipients: recips,
      intendedRecipients: recips,
      sends,
      surfaceCode: args.surfaceCode,
      siteId: args.site?.id ?? null,
    };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { ALERT_DIGEST: 'alert_digest' } }));

const publishNtfy = vi.fn();
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...a) }));

const DAY_KEY = new Date(Date.UTC(2026, 6, 4)); // 2026-07-04
vi.mock('@/lib/time', () => ({
  appToday: () => DAY_KEY,
  dayISO: (d: Date) => d.toISOString().slice(0, 10),
}));

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
  opsTaskFindMany.mockResolvedValue([]); // no due tasks by default
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

  it('skips when there are no open R/M findings AND no due tasks (no email, no log)', async () => {
    findingFindMany.mockResolvedValue([]);
    opsTaskFindMany.mockResolvedValue([]);
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]).toEqual({ siteCode: 'woodland', status: 'skipped_no_findings' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(logCreate).not.toHaveBeenCalled();
  });

  it('ADR-0045 — sends a tasks-only digest when there are due tasks but no findings', async () => {
    findingFindMany.mockResolvedValue([]);
    // one overdue (due before DAY_KEY) + one due today (== DAY_KEY)
    opsTaskFindMany.mockResolvedValue([
      { id: 't1', site_id: 'site-w', title: 'Call MRC rep', due_date: new Date(Date.UTC(2026, 6, 1)), assignee_user_id: null },
      { id: 't2', site_id: 'site-w', title: 'Snapshot yard', due_date: DAY_KEY, assignee_user_id: null },
    ]);
    const { outcomes } = await runAlertDigestFire(NOW);
    expect(outcomes[0]!.status).toBe('sent');
    expect(sendSystemEmail).toHaveBeenCalledTimes(2); // per recipient
    const html = sendSystemEmail.mock.calls[0]![0].htmlBody as string;
    expect(html).toContain('Follow-ups due');
    expect(html).toContain('Call MRC rep');
    expect(html).toContain('OVERDUE');
    expect(html).toContain('DUE TODAY');
    expect(logCreate.mock.calls[0]![0].data).toMatchObject({ finding_count: 0 });
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
