// ADR-0034 — Render and send the survey invite email.
// ADR-0036 — Render and send the survey reminder email (tiered copy).
//
// SVdP-branded shell matching the daily production report email:
//   - red #a3151a masthead with SVdP wordmark
//   - gold #ffcc69 accent bar
//   - cream #f7f3ea panels
//   - inline-styled table-based ≤600px Outlook fidelity
//
// Per-recipient send. From, display name, reply-to drive from the campaign
// record. Never throws — fail-soft logs and returns delivered=false.
//
// The invite and the three reminder tiers share ONE branded shell
// (`renderShell`); each caller supplies only the body paragraphs, the button
// label, and the small print — so the masthead/footer/escaping live in a single
// place (ADR-0036 §copy tiers: "share the shell rather than duplicate it").

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import type { SurveyCampaign, SurveyInvite } from '@prisma/client';

export interface SendInviteArgs {
  campaign: Pick<
    SurveyCampaign,
    'title' | 'intro_text' | 'subject_template' | 'from_address' | 'from_display_name' | 'reply_to'
  >;
  invite: Pick<SurveyInvite, 'recipient_name' | 'recipient_email' | 'role_label' | 'token'>;
  baseUrl: string;
}

export interface SendInviteResult {
  delivered: boolean;
  last_status: number | null;
  graph_message_id: string | undefined;
}

// Bill's sign-off for the first-person reminder tiers (a/b). Tier c re-sends the
// original `intro_text`, which already carries his sign-off, so it is NOT added
// there.
const SIGN_OFF = '— Bill Barnard, Director of Operations';

// The small print under the invite button — kept verbatim so the invite email
// renders byte-identically after the shell refactor.
const INVITE_HELPER_TEXT =
  'No login required. Responses save as you type; you can come back to finish later. Should take 20-45 minutes depending on how much detail you want to share.';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render free text (double-newline = paragraph break, single newline = <br />)
// into the escaped, inline-styled paragraphs the shell body expects.
function renderParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;line-height:1.55;color:#2a2a2a;font-size:14px">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');
}

function surveyUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/survey/${token}`;
}

interface ShellArgs {
  recipientName: string;
  /** Pre-rendered, escaped body paragraphs (use `renderParagraphs`). */
  bodyHtml: string;
  buttonLabel: string;
  surveyUrl: string;
  helperText: string;
}

// The single branded shell shared by the invite + every reminder tier. Only the
// greeting, body, button label, small print, and direct link vary; the masthead,
// gold bar, and footer are constant.
function renderShell(args: ShellArgs): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f3ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f3ea">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #e8e2d4">
        <tr><td style="background:#a3151a;padding:18px 24px;color:#ffffff">
          <div style="font-size:18px;font-weight:600;letter-spacing:0.02em">St. Vincent de Paul · DR3</div>
          <div style="font-size:13px;opacity:0.9;margin-top:4px">DR3 Operational Intelligence</div>
        </td></tr>
        <tr><td style="background:#ffcc69;height:3px;line-height:3px;font-size:0">&nbsp;</td></tr>
        <tr><td style="padding:28px 28px 8px">
          <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a">Hi ${escapeHtml(args.recipientName)},</p>
          ${args.bodyHtml}
        </td></tr>
        <tr><td style="padding:8px 28px 24px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#a3151a;border-radius:4px">
              <a href="${escapeHtml(args.surveyUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.02em">${escapeHtml(args.buttonLabel)}</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#666666">${escapeHtml(args.helperText)}</p>
          <p style="margin:8px 0 0;font-size:11px;color:#999999;word-break:break-all">Direct link: ${escapeHtml(args.surveyUrl)}</p>
        </td></tr>
        <tr><td style="background:#f7f3ea;padding:14px 24px;border-top:1px solid #e8e2d4">
          <p style="margin:0;font-size:11px;color:#888888;line-height:1.4">This survey was created by Bill Barnard. Responses feed directly into the design of a new DR3 data management system intended to safeguard and automate processes, free up staff time, verify data accuracy, and improve overall operational tracking. Reply to this email if anything is unclear.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function renderInviteHtml(args: SendInviteArgs): string {
  return renderShell({
    recipientName: args.invite.recipient_name,
    bodyHtml: renderParagraphs(args.campaign.intro_text),
    buttonLabel: 'Open your survey',
    surveyUrl: surveyUrlFor(args.baseUrl, args.invite.token),
    helperText: INVITE_HELPER_TEXT,
  });
}

export async function sendInvite(args: SendInviteArgs): Promise<SendInviteResult> {
  const subject = args.campaign.subject_template;
  const htmlBody = renderInviteHtml(args);
  try {
    const r = await sendSystemEmail({
      to: { address: args.invite.recipient_email, name: args.invite.recipient_name },
      subject,
      htmlBody,
      importance: 'normal',
      fromDisplayName: args.campaign.from_display_name,
      replyTo: args.campaign.reply_to,
    });
    if (r.disabled) {
      log.warn({ inviteEmail: args.invite.recipient_email }, '[survey] M365 disabled — skip');
      return { delivered: false, last_status: null, graph_message_id: undefined };
    }
    return {
      delivered: r.delivered,
      last_status: r.lastStatus ?? null,
      graph_message_id: r.messageId,
    };
  } catch (e) {
    log.warn({ err: e, inviteEmail: args.invite.recipient_email }, '[survey] send threw');
    return { delivered: false, last_status: null, graph_message_id: undefined };
  }
}

// ─── ADR-0036 — Reminder email (three tiers) ───────────────────────────

/**
 * Which reminder copy to send, keyed off the invite's live state:
 *   - `saved_progress`    — opened AND has ≥1 saved answer (finish + submit).
 *   - `opened_no_answers` — opened but nothing saved yet (friendly nudge).
 *   - `never_opened`      — sent, never opened (resend the original).
 */
export type ReminderTier = 'saved_progress' | 'opened_no_answers' | 'never_opened';

export interface SendReminderArgs {
  campaign: Pick<
    SurveyCampaign,
    'intro_text' | 'subject_template' | 'from_address' | 'from_display_name' | 'reply_to'
  >;
  invite: Pick<SurveyInvite, 'recipient_name' | 'recipient_email' | 'role_label' | 'token'>;
  tier: ReminderTier;
  baseUrl: string;
}

export type SendReminderResult = SendInviteResult;

// Per-tier subject. Tiers a/b prefix "Reminder:"; tier c re-sends under the
// ORIGINAL subject so an unopened first copy and the resend read as one thread
// rather than announcing themselves as a nag.
export function reminderSubject(tier: ReminderTier, subjectTemplate: string): string {
  return tier === 'never_opened' ? subjectTemplate : `Reminder: ${subjectTemplate}`;
}

interface TierCopy {
  buttonLabel: string;
  helperText: string;
  bodyHtml: string;
}

function tierCopy(tier: ReminderTier, introText: string): TierCopy {
  switch (tier) {
    case 'saved_progress':
      return {
        buttonLabel: 'Finish your survey',
        helperText: 'No login required — pick up right where you left off.',
        bodyHtml: renderParagraphs(
          `Thanks again for starting the DR3 operations survey. Your progress is saved and ` +
            `waiting right where you left it — nothing was lost. Would you take a few minutes ` +
            `to finish the remaining questions and submit? Your answers go straight into the ` +
            `design of the new DR3 data system, and yours are close to done.\n\n${SIGN_OFF}`,
        ),
      };
    case 'opened_no_answers':
      return {
        buttonLabel: 'Open your survey',
        helperText: 'No login required. Responses save as you type.',
        bodyHtml: renderParagraphs(
          `I see you opened the DR3 operations survey but haven't submitted it yet — no worries. ` +
            `It takes about 20-45 minutes, your responses save as you type so you can stop and ` +
            `come back, and you can skip anything that doesn't apply to your role. Your ` +
            `perspective is exactly the kind of detail we need to get the new data system right.` +
            `\n\n${SIGN_OFF}`,
        ),
      };
    case 'never_opened':
      // Resend the ORIGINAL intro (which already carries Bill's sign-off),
      // prefixed with a single resend line.
      return {
        buttonLabel: 'Open your survey',
        helperText: INVITE_HELPER_TEXT,
        bodyHtml: renderParagraphs(
          `Resending this in case an earlier copy didn't reach you or got buried.\n\n${introText}`,
        ),
      };
  }
}

export function renderReminderHtml(args: SendReminderArgs): string {
  const copy = tierCopy(args.tier, args.campaign.intro_text);
  return renderShell({
    recipientName: args.invite.recipient_name,
    bodyHtml: copy.bodyHtml,
    buttonLabel: copy.buttonLabel,
    surveyUrl: surveyUrlFor(args.baseUrl, args.invite.token),
    helperText: copy.helperText,
  });
}

export async function sendReminder(args: SendReminderArgs): Promise<SendReminderResult> {
  const subject = reminderSubject(args.tier, args.campaign.subject_template);
  const htmlBody = renderReminderHtml(args);
  try {
    const r = await sendSystemEmail({
      to: { address: args.invite.recipient_email, name: args.invite.recipient_name },
      subject,
      htmlBody,
      importance: 'normal',
      fromDisplayName: args.campaign.from_display_name,
      replyTo: args.campaign.reply_to,
    });
    if (r.disabled) {
      log.warn(
        { inviteEmail: args.invite.recipient_email },
        '[survey] M365 disabled — skip reminder',
      );
      return { delivered: false, last_status: null, graph_message_id: undefined };
    }
    return {
      delivered: r.delivered,
      last_status: r.lastStatus ?? null,
      graph_message_id: r.messageId,
    };
  } catch (e) {
    log.warn({ err: e, inviteEmail: args.invite.recipient_email }, '[survey] reminder send threw');
    return { delivered: false, last_status: null, graph_message_id: undefined };
  }
}
