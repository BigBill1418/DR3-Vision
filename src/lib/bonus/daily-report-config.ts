// ADR-0030 — Config + recipients CRUD service.
//
// Every mutation writes its audit row in the SAME transaction
// (CLAUDE.md hard rule #6). All callers must already have passed the
// super-admin gate; this layer assumes auth and trusts the actorUserId.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface ConfigPatchInput {
  // `| undefined` is explicit because the repo runs with
  // `exactOptionalPropertyTypes` — zod `.optional()` yields `T | undefined`,
  // and each field is guarded with `!== undefined` before use below.
  enabled?: boolean | undefined;
  sendTimePt?: string | undefined; // 'HH:MM' or 'HH:MM:SS'
  subjectTemplate?: string | undefined;
  skipIfZero?: boolean | undefined;
  skipWeekends?: boolean | undefined;
  skipHolidays?: boolean | undefined;
  includeBonusDollars?: boolean | undefined;
  includeComparisons?: boolean | undefined;
}

export class DailyReportConfigError extends Error {
  readonly status: number;
  constructor(
    public readonly reason: 'not_found' | 'invalid_time' | 'invalid_email' | 'duplicate_email',
    statusCode = 422,
  ) {
    super(`daily-report-config: ${reason}`);
    this.name = 'DailyReportConfigError';
    this.status = statusCode;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cast to satisfy Prisma's Json input type. Stringifying then re-parsing is the
// cheapest portable serializer for "anything serializable that I have on hand"
// (mirrors src/lib/audit.ts).
function serialize(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/** Returns the rendered config view for the admin UI, both sites. */
export async function listConfigs() {
  return prisma.bonusDailyReportConfig.findMany({
    orderBy: { site: { code: 'asc' } },
    include: {
      site: { select: { id: true, code: true, name: true } },
      recipients: {
        orderBy: { email: 'asc' },
        include: { added_by: { select: { name: true, email: true } } },
      },
    },
  });
}

export async function getConfigBySite(siteId: string) {
  return prisma.bonusDailyReportConfig.findUnique({
    where: { site_id: siteId },
    include: {
      site: { select: { id: true, code: true, name: true } },
      recipients: { orderBy: { email: 'asc' } },
    },
  });
}

export async function patchConfig(
  configId: string,
  patch: ConfigPatchInput,
  actor: { userId: string; ip: string | null; userAgent: string | null },
) {
  // Normalize the time. We accept HH:MM and store HH:MM:00.
  let send_time_pt: Date | undefined;
  if (patch.sendTimePt !== undefined) {
    if (!TIME_RE.test(patch.sendTimePt)) {
      throw new DailyReportConfigError('invalid_time', 422);
    }
    const padded = patch.sendTimePt.length === 5 ? `${patch.sendTimePt}:00` : patch.sendTimePt;
    // Prisma TIME column accepts a Date; we pass a 1970-01-01 anchor whose
    // time component is what we want stored.
    send_time_pt = new Date(`1970-01-01T${padded}.000Z`);
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.bonusDailyReportConfig.findUnique({ where: { id: configId } });
    if (!before) throw new DailyReportConfigError('not_found', 404);

    const updated = await tx.bonusDailyReportConfig.update({
      where: { id: configId },
      data: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(send_time_pt !== undefined ? { send_time_pt } : {}),
        ...(patch.subjectTemplate !== undefined ? { subject_template: patch.subjectTemplate } : {}),
        ...(patch.skipIfZero !== undefined ? { skip_if_zero: patch.skipIfZero } : {}),
        ...(patch.skipWeekends !== undefined ? { skip_weekends: patch.skipWeekends } : {}),
        ...(patch.skipHolidays !== undefined ? { skip_holidays: patch.skipHolidays } : {}),
        ...(patch.includeBonusDollars !== undefined
          ? { include_bonus_dollars: patch.includeBonusDollars }
          : {}),
        ...(patch.includeComparisons !== undefined
          ? { include_comparisons: patch.includeComparisons }
          : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'bonus_daily_report_config',
        row_id: configId,
        before: serialize({
          enabled: before.enabled,
          send_time_pt: before.send_time_pt,
          subject_template: before.subject_template,
          skip_if_zero: before.skip_if_zero,
          skip_weekends: before.skip_weekends,
          skip_holidays: before.skip_holidays,
          include_bonus_dollars: before.include_bonus_dollars,
          include_comparisons: before.include_comparisons,
        }),
        after: serialize({
          enabled: updated.enabled,
          send_time_pt: updated.send_time_pt,
          subject_template: updated.subject_template,
          skip_if_zero: updated.skip_if_zero,
          skip_weekends: updated.skip_weekends,
          skip_holidays: updated.skip_holidays,
          include_bonus_dollars: updated.include_bonus_dollars,
          include_comparisons: updated.include_comparisons,
        }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });

    return updated;
  });
}

export async function addRecipient(
  configId: string,
  emailRaw: string,
  actor: { userId: string; ip: string | null; userAgent: string | null },
) {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new DailyReportConfigError('invalid_email', 422);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.bonusDailyReportRecipient.findUnique({
      where: { config_id_email: { config_id: configId, email } },
    });
    if (existing) throw new DailyReportConfigError('duplicate_email', 409);

    const created = await tx.bonusDailyReportRecipient.create({
      data: { config_id: configId, email, added_by_user_id: actor.userId },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'insert',
        table_name: 'bonus_daily_report_recipients',
        row_id: created.id,
        before: Prisma.JsonNull,
        after: serialize({ config_id: configId, email }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });

    return created;
  });
}

export async function removeRecipient(
  recipientId: string,
  actor: { userId: string; ip: string | null; userAgent: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.bonusDailyReportRecipient.findUnique({ where: { id: recipientId } });
    if (!before) throw new DailyReportConfigError('not_found', 404);

    await tx.bonusDailyReportRecipient.delete({ where: { id: recipientId } });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'delete',
        table_name: 'bonus_daily_report_recipients',
        row_id: recipientId,
        before: serialize({ config_id: before.config_id, email: before.email }),
        after: Prisma.JsonNull,
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
  });
}

export async function listRecentSends(siteId: string | null, limit = 30) {
  return prisma.bonusDailyReportLog.findMany({
    where: siteId ? { site_id: siteId } : {},
    orderBy: { sent_at: 'desc' },
    take: limit,
    include: { site: { select: { code: true, name: true } } },
  });
}
