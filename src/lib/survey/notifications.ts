// ADR-0034 — Render and send the survey invite email.
//
// SVdP-branded shell matching the daily production report email:
//   - red #a3151a masthead with SVdP wordmark
//   - gold #ffcc69 accent bar
//   - cream #f7f3ea panels
//   - inline-styled table-based ≤600px Outlook fidelity
//
// Per-recipient send. From, display name, reply-to drive from the campaign
// record. Never throws — fail-soft logs and returns delivered=false.

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import type { SurveyCampaign, SurveyInvite } from '@prisma/client';

export interface SendInviteArgs {
  campaign: Pick<
    SurveyCampaign,
    | 'title'
    | 'intro_text'
    | 'subject_template'
    | 'from_address'
    | 'from_display_name'
    | 'reply_to'
  >;
  invite: Pick<SurveyInvite, 'recipient_name' | 'recipient_email' | 'role_label' | 'token'>;
  baseUrl: string;
}

export interface SendInviteResult {
  delivered: boolean;
  last_status: number | null;
  graph_message_id: string | undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIntro(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;line-height:1.55;color:#2a2a2a;font-size:14px">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');
}

export function renderInviteHtml(args: SendInviteArgs): string {
  const surveyUrl = `${args.baseUrl.replace(/\/+$/, '')}/survey/${args.invite.token}`;
  const intro = renderIntro(args.campaign.intro_text);
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
          <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a">Hi ${escapeHtml(args.invite.recipient_name)},</p>
          ${intro}
        </td></tr>
        <tr><td style="padding:8px 28px 24px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#a3151a;border-radius:4px">
              <a href="${escapeHtml(surveyUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.02em">Open your survey</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#666666">No login required. Responses save as you type; you can come back to finish later. Should take 20-45 minutes depending on how much detail you want to share.</p>
          <p style="margin:8px 0 0;font-size:11px;color:#999999;word-break:break-all">Direct link: ${escapeHtml(surveyUrl)}</p>
        </td></tr>
        <tr><td style="background:#f7f3ea;padding:14px 24px;border-top:1px solid #e8e2d4">
          <p style="margin:0;font-size:11px;color:#888888;line-height:1.4">This survey was created by Bill Barnard. Responses feed directly into the design of a new DR3 data management system intended to safeguard and automate processes, free up staff time, verify data accuracy, and improve overall operational tracking. Reply to this email if anything is unclear.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
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
