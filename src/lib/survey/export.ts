// ADR-0034 — Export survey responses as markdown to docs/operations-intel/.
//
// Generates one .md file per submitted invite plus a consolidated _summary.md.
// Files are pushed via the same ClaudeSync handoff mechanism used by sprint
// handoffs, just under docs/operations-intel/{campaign-slug}/.

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import type { SurveyQuestion, SurveyResponse } from '@prisma/client';

const SLUG_NORMALIZE_RE = /[^a-z0-9-]+/g;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(SLUG_NORMALIZE_RE, '');
}

function renderAnswer(q: SurveyQuestion, r: SurveyResponse | undefined): string {
  if (!r) return '*(no response)*';
  if (q.kind === 'multi_select') {
    const json = r.answer_json as unknown;
    if (Array.isArray(json)) {
      return (json as unknown[]).map((v) => `- ${String(v)}`).join('\n');
    }
    return r.answer_text ?? '*(no response)*';
  }
  return (r.answer_text && r.answer_text.trim()) || '*(no response)*';
}

export interface ExportFile {
  path: string;
  body: string;
}

export async function buildExport(campaignId: string): Promise<ExportFile[]> {
  const campaign = await prisma.surveyCampaign.findUnique({
    where: { id: campaignId },
    include: {
      created_by: { select: { name: true, email: true } },
      invites: {
        where: { submitted_at: { not: null } },
        orderBy: { recipient_name: 'asc' },
        include: {
          questions: { orderBy: { position: 'asc' } },
          responses: true,
        },
      },
    },
  });
  if (!campaign) return [];

  const dir = `docs/operations-intel/${campaign.slug}`;
  const files: ExportFile[] = [];

  for (const invite of campaign.invites) {
    const respByQ = new Map(invite.responses.map((r) => [r.question_id, r]));
    const recipientSlug = slugify(invite.recipient_name);
    const lines: string[] = [];
    lines.push(`# ${invite.recipient_name} — ${invite.role_label}`);
    lines.push('');
    lines.push(`**Campaign:** ${campaign.title}`);
    lines.push(`**Recipient email:** ${invite.recipient_email}`);
    lines.push(`**Submitted at:** ${invite.submitted_at?.toISOString() ?? '—'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const q of invite.questions) {
      lines.push(`## ${q.position}. ${q.prompt}`);
      if (q.description) {
        lines.push('');
        lines.push(`> ${q.description}`);
      }
      lines.push('');
      lines.push(renderAnswer(q, respByQ.get(q.id)));
      lines.push('');
    }
    files.push({ path: `${dir}/${recipientSlug}.md`, body: lines.join('\n') });
  }

  const summaryLines: string[] = [];
  summaryLines.push(`# ${campaign.title} — submission summary`);
  summaryLines.push('');
  summaryLines.push(`**Slug:** \`${campaign.slug}\`  `);
  summaryLines.push(`**Owner:** ${campaign.created_by.name} (${campaign.created_by.email})  `);
  summaryLines.push(`**Opened:** ${campaign.opened_at?.toISOString() ?? '—'}  `);
  summaryLines.push(`**Closed:** ${campaign.closed_at?.toISOString() ?? '—'}  `);
  summaryLines.push(`**Submissions:** ${campaign.invites.length}`);
  summaryLines.push('');
  summaryLines.push('## Respondents');
  summaryLines.push('');
  summaryLines.push('| Recipient | Role | Submitted | File |');
  summaryLines.push('|---|---|---|---|');
  for (const invite of campaign.invites) {
    const recipientSlug = slugify(invite.recipient_name);
    summaryLines.push(
      `| ${invite.recipient_name} | ${invite.role_label} | ${invite.submitted_at?.toISOString() ?? '—'} | \`${recipientSlug}.md\` |`,
    );
  }
  files.push({ path: `${dir}/_summary.md`, body: summaryLines.join('\n') });

  return files;
}

/**
 * Logs the export file plan. The actual ClaudeSync push is invoked from the
 * admin UI route handler (which has the operator's auth context); this module
 * only builds the file contents and returns them.
 */
export async function logExportSummary(campaignId: string): Promise<void> {
  const files = await buildExport(campaignId);
  for (const f of files) {
    log.info({ path: f.path, bytes: f.body.length }, '[survey] export file ready');
  }
}
