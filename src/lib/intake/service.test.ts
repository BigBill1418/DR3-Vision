import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeFindMany = vi.fn();
const txTaskCreate = vi.fn();
const txIntakeCreate = vi.fn();
const transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn({ opsTask: { create: txTaskCreate }, contactIntake: { create: txIntakeCreate } }),
);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contactRoute: { findMany: (...a: unknown[]) => routeFindMany(...a) },
    $transaction: (fn: (tx: unknown) => unknown) => transaction(fn),
  },
}));

const sendSystemEmail = vi.fn();
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...a) }));

const writeAudit = vi.fn();
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

// Capture every log call so we can prove PII never reaches the logger.
const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
vi.mock('@/lib/observability/logger', () => ({
  log: { info: (...a: unknown[]) => logInfo(...a), warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a) },
}));

import { handleContactIntake } from './service';

const ROUTES = [
  { id: 'r-tour', topic_match: 'tour*', route_to_email: 'rick.albritton@svdp.us', priority: 10 },
  { id: 'r-default', topic_match: '*', route_to_email: 'morena.gomez@svdp.us', priority: 1000 },
];

const PII = {
  name: 'Jane Visitor',
  email: 'jane@example.com',
  phone: '541-555-0100',
  message: 'Please call me about a tour, my SSN is not really here',
};

beforeEach(() => {
  vi.clearAllMocks();
  routeFindMany.mockResolvedValue(ROUTES);
  txTaskCreate.mockResolvedValue({ id: 'task-1' });
  txIntakeCreate.mockResolvedValue({ id: 'intake-1' });
  sendSystemEmail.mockResolvedValue({ delivered: true, disabled: false, messageId: 'm', retries: 0, lastStatus: undefined });
});

describe('handleContactIntake', () => {
  it('routes a tour to Rick, creates task + intake, notifies, returns accepted', async () => {
    const res = await handleContactIntake({ topic: 'Tour request', ...PII });
    expect(res).toEqual({ outcome: 'accepted', intakeId: 'intake-1', taskId: 'task-1' });
    expect(txTaskCreate.mock.calls[0]![0].data).toMatchObject({ source: 'contact_form', site_id: null });
    expect(txIntakeCreate.mock.calls[0]![0].data).toMatchObject({
      routed_to_email: 'rick.albritton@svdp.us',
      route_id: 'r-tour',
      task_id: 'task-1',
    });
    expect(sendSystemEmail.mock.calls[0]![0].to).toBe('rick.albritton@svdp.us');
  });

  it('routes a non-tour topic to the default (Morena)', async () => {
    await handleContactIntake({ topic: 'Donation question', ...PII });
    expect(sendSystemEmail.mock.calls[0]![0].to).toBe('morena.gomez@svdp.us');
  });

  it('silently accepts + writes nothing when the honeypot is filled', async () => {
    const res = await handleContactIntake({ topic: 'x', message: 'y', website: 'http://spam' });
    expect(res).toEqual({ outcome: 'honeypot' });
    expect(transaction).not.toHaveBeenCalled();
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('returns invalid on a malformed body (missing message)', async () => {
    const res = await handleContactIntake({ topic: 'x' });
    expect(res.outcome).toBe('invalid');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('holds the lead as a task (no email) when no route matches', async () => {
    routeFindMany.mockResolvedValue([]); // no default configured
    const res = await handleContactIntake({ topic: 'orphan', ...PII });
    expect(res.outcome).toBe('accepted');
    expect(txIntakeCreate.mock.calls[0]![0].data.routed_to_email).toBe('unrouted');
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it('PII DISCIPLINE — name/email/phone/message never reach the logger or the audit row', async () => {
    await handleContactIntake({ topic: 'Tour request', ...PII });
    const loggedBlob = JSON.stringify([logInfo.mock.calls, logWarn.mock.calls, logError.mock.calls]);
    const auditBlob = JSON.stringify(writeAudit.mock.calls);
    for (const secret of [PII.name, PII.email, PII.phone, PII.message]) {
      expect(loggedBlob).not.toContain(secret);
      expect(auditBlob).not.toContain(secret);
    }
    // The email delivery IS allowed to carry the PII (the routed person needs it).
    expect(JSON.stringify(sendSystemEmail.mock.calls)).toContain(PII.email);
  });
});
