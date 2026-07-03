// ADR-0036 — Survey daily reminders + campaign auto-close (the testable core).
//
// This is the work the thin Pacific scheduler (`scripts/survey-reminder-cron.mjs`)
// triggers by POSTing the internal route `/api/internal/survey/reminder-tick`.
// The daemon stays plain JS (no tsx, no TS import) because the prod image is
// `npm ci --omit=dev`; all real work runs compiled inside the Next app, here.
//
// Once per day (09:00 PT), for every OPEN campaign:
//   - Reminders: each invite still `sent` or `opened` gets ONE reminder per day
//     (20h DB gate — a slightly-early fire still counts as the next day). Tier is
//     chosen from the invite's live state (saved answers → finish-and-submit;
//     opened-but-empty → friendly nudge; never-opened → resend the original).
//     `last_reminder_at`/`reminder_count` are stamped ONLY on a successful send,
//     so a failed send retries next tick and a restart never double-sends.
//   - Auto-close: once at least one invite is `submitted` and NOTHING is still
//     outstanding (`approved`/`sent`/`opened`), the campaign closes under the
//     system actor and a `dr3-vision-system` ntfy fires. Drafts do NOT block —
//     a draft is an operator's un-sent exclusion, not a pending respondent.
//
// Per-invite work is wrapped in try/catch: one invite throwing never stops the
// others and never throws out of this function (the route stays 200). The export
// itself is NOT run here — the admin Export button (`export_only=true`) works
// after close (ADR-0036 §consequences).

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { closeCampaign } from '@/lib/survey/campaigns';
import { sendReminder, type ReminderTier } from '@/lib/survey/notifications';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';

// 20h, not 24h: a fire that lands a little early (scheduler jitter, restart)
// still clears the previous day's stamp, so we never skip a day. Two reminders
// can't land inside the same 20h window.
const REMINDER_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

const SYSTEM_ACTOR_LABEL = 'system:survey-reminder-cron';

// Only invites that were actually emailed are ever reminded.
const REMINDER_STATUSES: readonly string[] = ['sent', 'opened'];
// An invite in any of these still awaits a respondent → blocks auto-close.
const AUTO_CLOSE_BLOCKING_STATUSES: readonly string[] = ['approved', 'sent', 'opened'];

// Same base-URL mechanism the campaign send route uses (`PUBLIC_BASE_URL` with a
// `dr3-vision.svdp.us` default), so reminder links match invite links exactly.
function defaultBaseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

export interface SurveyReminderSummary {
  campaigns: number;
  remindersSent: number;
  remindersFailed: number;
  remindersSkipped: number;
  closed: string[];
}

export interface RunSurveyReminderTickOpts {
  /** Production passes the Prisma singleton; tests inject a double. */
  db?: PrismaClient;
  /** Injectable clock for deterministic gate tests. Defaults to `new Date()`. */
  now?: Date;
  /** Override the derived base URL (tests). */
  baseUrl?: string;
}

// Pick the reminder copy tier from the invite's live state + saved-answer count.
function classifyTier(status: string, responseCount: number): ReminderTier {
  if (status === 'opened') return responseCount >= 1 ? 'saved_progress' : 'opened_no_answers';
  return 'never_opened'; // status === 'sent'
}

export async function runSurveyReminderTick(
  opts: RunSurveyReminderTickOpts = {},
): Promise<SurveyReminderSummary> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const base = opts.baseUrl ?? defaultBaseUrl();
  const cutoff = new Date(now.getTime() - REMINDER_MIN_INTERVAL_MS);

  const summary: SurveyReminderSummary = {
    campaigns: 0,
    remindersSent: 0,
    remindersFailed: 0,
    remindersSkipped: 0,
    closed: [],
  };

  const campaigns = await db.surveyCampaign.findMany({
    where: { status: 'open' },
    include: {
      // Count ALL responses (draft answers count as progress — a saved-but-
      // unsubmitted invite is the `saved_progress` tier).
      invites: { include: { _count: { select: { responses: true } } } },
    },
  });
  summary.campaigns = campaigns.length;

  for (const campaign of campaigns) {
    // ── Reminders ──────────────────────────────────────────────────────
    for (const invite of campaign.invites) {
      if (!REMINDER_STATUSES.includes(invite.status)) continue;

      // Daily gate: skip if reminded within the last 20h.
      if (invite.last_reminder_at !== null && invite.last_reminder_at > cutoff) {
        summary.remindersSkipped++;
        continue;
      }

      const tier = classifyTier(invite.status, invite._count.responses);
      try {
        const r = await sendReminder({
          campaign: {
            intro_text: campaign.intro_text,
            subject_template: campaign.subject_template,
            from_address: campaign.from_address,
            from_display_name: campaign.from_display_name,
            reply_to: campaign.reply_to,
          },
          invite: {
            recipient_name: invite.recipient_name,
            recipient_email: invite.recipient_email,
            role_label: invite.role_label,
            token: invite.token,
          },
          tier,
          baseUrl: base,
        });
        if (r.delivered) {
          // Stamp ONLY on success — a failed send is retried next tick.
          await db.surveyInvite.update({
            where: { id: invite.id },
            data: { last_reminder_at: now, reminder_count: { increment: 1 } },
          });
          summary.remindersSent++;
          log.info({ inviteId: invite.id, tier }, '[survey-reminder] reminder sent');
        } else {
          summary.remindersFailed++;
          log.warn(
            { inviteId: invite.id, tier, lastStatus: r.last_status },
            '[survey-reminder] reminder not delivered',
          );
        }
      } catch (e) {
        // Never throw past an individual invite (fail-soft, mirrors sendInvite).
        summary.remindersFailed++;
        log.warn({ err: e, inviteId: invite.id }, '[survey-reminder] reminder threw');
      }
    }

    // ── Auto-close ─────────────────────────────────────────────────────
    const submitted = campaign.invites.filter((i) => i.status === 'submitted').length;
    const outstanding = campaign.invites.filter((i) =>
      AUTO_CLOSE_BLOCKING_STATUSES.includes(i.status),
    ).length;

    if (submitted >= 1 && outstanding === 0) {
      try {
        await closeCampaign(campaign.id, { actorLabel: SYSTEM_ACTOR_LABEL });
        summary.closed.push(campaign.id);
        await publishNtfy({
          topic: 'dr3-vision-system',
          title: 'Survey campaign complete — auto-closed',
          body:
            `"${campaign.title}" auto-closed: every outstanding response is in ` +
            `(${submitted}/${campaign.invites.length} submitted). Export via the admin UI.`,
          priority: 'default',
          tags: ['survey', 'dr3-vision'],
          clickUrl: `https://dr3-vision.svdp.us/admin/operations/intel/${campaign.id}`,
          fingerprint: `survey-campaign-autoclosed:${campaign.id}`,
        });
        log.info({ campaignId: campaign.id, submitted }, '[survey-reminder] campaign auto-closed');
      } catch (e) {
        log.warn({ err: e, campaignId: campaign.id }, '[survey-reminder] auto-close failed');
      }
    }
  }

  return summary;
}
