// ADR-0045 D3 — contact-intake service: validate → route → task + notify.
//
// PII DISCIPLINE (hard): name / email / phone / message are visitor PII. They
// are persisted on `contact_intakes` and included in the routed notification
// email (the routed person needs them), but they are NEVER written to a log.
// Every log line here carries row ids + the topic (a category, not PII) only.
// There is a log-absence test asserting no PII value reaches the logger.
//
// D4 — a lost lead is a task, not an outage: even if routing fails (no default
// route configured), the submission still becomes a task so it is never dropped;
// the endpoint being DOWN is caught by normal app health, not paged here.

import { prisma } from '@/lib/prisma';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { writeAudit } from '@/lib/audit';
import { log } from '@/lib/observability/logger';
import { contactIntakeSchema, HONEYPOT_FIELD, type ContactIntakeInput } from './schema';
import { resolveRoute } from './routing';

export type IntakeResult =
  | { outcome: 'accepted'; intakeId: string; taskId: string }
  | { outcome: 'honeypot' }
  | { outcome: 'invalid'; issues: string[] };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notificationHtml(topic: string, input: ContactIntakeInput): string {
  const rows: Array<[string, string | undefined]> = [
    ['Topic', topic],
    ['Name', input.name],
    ['Email', input.email || undefined],
    ['Phone', input.phone],
  ];
  const meta = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<p style="margin:2px 0;font-size:14px"><strong>${k}:</strong> ${esc(v!)}</p>`)
    .join('');
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1a1a1a">
    <h2 style="color:#00524C;font-size:18px">New website contact — ${esc(topic)}</h2>
    ${meta}
    <p style="margin:12px 0 4px;font-size:13px;color:#5f6b69">Message:</p>
    <p style="white-space:pre-wrap;font-size:14px;border-left:3px solid #d9e3e0;padding-left:10px">${esc(input.message)}</p>
    <p style="margin-top:16px;font-size:12px;color:#5f6b69">Logged as a DR3-Vision follow-up task. This is a system notification.</p>
  </body></html>`;
}

/**
 * Handle a parsed-or-raw intake body. `raw` is the untrusted JSON; validation
 * happens here.
 */
export async function handleContactIntake(raw: unknown): Promise<IntakeResult> {
  const parsed = contactIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    return { outcome: 'invalid', issues: parsed.error.issues.map((i) => i.path.join('.') || 'body') };
  }
  const input = parsed.data;

  // Honeypot filled → silent accept, write nothing (bot).
  const honeypot = (raw as Record<string, unknown> | null)?.[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.length > 0) {
    log.info({ event: 'intake_honeypot', topic: input.topic }, '[intake] honeypot tripped — dropped');
    return { outcome: 'honeypot' };
  }

  const route = await resolveRoute(input.topic);
  const routedEmail = route?.routeToEmail ?? null;

  // Create the task + intake atomically (a lead is never half-recorded).
  const { intake, task } = await prisma.$transaction(async (tx) => {
    const task = await tx.opsTask.create({
      data: {
        site_id: null, // a website lead is org-wide until triaged
        title: `Contact form: ${input.topic}`.slice(0, 200),
        body: input.message,
        source: 'contact_form',
        created_by: 'system:contact-intake',
      },
    });
    const intake = await tx.contactIntake.create({
      data: {
        topic: input.topic,
        name: input.name ?? null,
        email: input.email || null,
        phone: input.phone ?? null,
        message: input.message,
        routed_to_email: routedEmail ?? 'unrouted',
        route_id: route?.id ?? null,
        task_id: task.id,
        source_form: input.source_form,
      },
    });
    return { intake, task };
  });

  await writeAudit({
    actor_label: 'system:contact-intake',
    action: 'insert',
    table_name: 'contact_intakes',
    row_id: intake.id,
    // Audit carries ids + routing decision, NEVER the PII values.
    after: { topic: input.topic, route_id: route?.id ?? null, task_id: task.id },
  });

  if (routedEmail) {
    try {
      // ADR-0047 — org-wide contact-intake surface. In pilot this reroutes to
      // admins (the routed staffer receives nothing until Bill ramps it).
      await notifyStaff({
        surfaceCode: NOTIFY_SURFACE.CONTACT_INTAKE_NOTIFY,
        site: null,
        recipients: [routedEmail],
        subject: `New website contact — ${input.topic}`,
        htmlBody: notificationHtml(input.topic, input),
        fromDisplayName: 'DR3-Vision Contact',
      });
    } catch (err) {
      // Delivery failure never drops the lead — the task already exists.
      log.error(
        { err, event: 'intake_notify_failed', intakeId: intake.id, routeId: route?.id ?? null },
        '[intake] routed notification failed (lead preserved as task)',
      );
    }
    log.info(
      { event: 'intake_accepted', intakeId: intake.id, taskId: task.id, routeId: route?.id ?? null, topic: input.topic },
      '[intake] accepted + routed',
    );
  } else {
    log.warn(
      { event: 'intake_unrouted', intakeId: intake.id, taskId: task.id, topic: input.topic },
      '[intake] no active route matched — lead held as task (configure a default route)',
    );
  }

  return { outcome: 'accepted', intakeId: intake.id, taskId: task.id };
}
