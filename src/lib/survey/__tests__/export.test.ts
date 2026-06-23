// ADR-0034 — markdown export tests (§14.4).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    surveyCampaign: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { buildExport } from '../export';

const BASE_CAMPAIGN = {
  id: 'camp-1',
  slug: 'dr3-intel-2026-06',
  title: 'DR3 Operational Intelligence — June 2026',
  opened_at: new Date('2026-06-22T00:00:00.000Z'),
  closed_at: new Date('2026-06-30T00:00:00.000Z'),
  created_by: { name: 'Bill Barnard', email: 'bill.barnard@svdp.us' },
  invites: [] as unknown[],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildExport', () => {
  it('27. produces no per-recipient files when the campaign has no submitted invites (summary only)', async () => {
    // Spec §14.4 case 27 phrasing is "no files"; the verbatim export.ts always
    // emits the consolidated _summary.md even with zero submissions, and only
    // returns [] for a non-existent campaign. We assert the real behavior: no
    // per-recipient .md files, just the summary.
    findUnique.mockResolvedValue({ ...BASE_CAMPAIGN, invites: [] });
    const files = await buildExport('camp-1');
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('docs/operations-intel/dr3-intel-2026-06/_summary.md');
    expect(files.some((f) => !f.path.endsWith('_summary.md'))).toBe(false);
  });

  it('27b. returns no files at all when the campaign does not exist', async () => {
    findUnique.mockResolvedValue(null);
    expect(await buildExport('missing')).toEqual([]);
  });

  it('28. generates one .md per submitted invite plus a _summary.md', async () => {
    findUnique.mockResolvedValue({
      ...BASE_CAMPAIGN,
      invites: [
        {
          recipient_name: 'Rick Albritton',
          role_label: 'Eugene Manager',
          recipient_email: 'rick@svdp.us',
          submitted_at: new Date('2026-06-25T12:00:00.000Z'),
          questions: [
            { id: 'q1', position: 1, prompt: 'A?', description: null, kind: 'long_text' },
            { id: 'q2', position: 2, prompt: 'B?', description: 'hint', kind: 'multi_select' },
          ],
          responses: [
            { question_id: 'q1', answer_text: 'Answer A', answer_json: null },
            { question_id: 'q2', answer_text: null, answer_json: ['x', 'y'] },
          ],
        },
        {
          recipient_name: 'Mary Scott',
          role_label: 'Accounting',
          recipient_email: 'mary@svdp.us',
          submitted_at: new Date('2026-06-26T09:00:00.000Z'),
          questions: [{ id: 'q3', position: 1, prompt: 'C?', description: null, kind: 'short_text' }],
          responses: [{ question_id: 'q3', answer_text: 'Answer C', answer_json: null }],
        },
      ],
    });

    const files = await buildExport('camp-1');
    const paths = files.map((f) => f.path);
    expect(paths).toContain('docs/operations-intel/dr3-intel-2026-06/rick-albritton.md');
    expect(paths).toContain('docs/operations-intel/dr3-intel-2026-06/mary-scott.md');
    expect(paths).toContain('docs/operations-intel/dr3-intel-2026-06/_summary.md');
    expect(files).toHaveLength(3);

    const rick = files.find((f) => f.path.endsWith('rick-albritton.md'));
    expect(rick?.body).toContain('# Rick Albritton — Eugene Manager');
    expect(rick?.body).toContain('Answer A');
    // multi_select renders the JSON array as markdown bullets.
    expect(rick?.body).toContain('- x');
    expect(rick?.body).toContain('- y');
    // The description renders as a blockquote.
    expect(rick?.body).toContain('> hint');

    const summary = files.find((f) => f.path.endsWith('_summary.md'));
    expect(summary?.body).toContain('**Submissions:** 2');
    expect(summary?.body).toContain('`rick-albritton.md`');
    expect(summary?.body).toContain('`mary-scott.md`');
  });

  it('29. slugifies recipient names safely (no slashes, spaces, accents)', async () => {
    findUnique.mockResolvedValue({
      ...BASE_CAMPAIGN,
      invites: [
        {
          recipient_name: 'José  D/Angelo  Smith ',
          role_label: 'Floor',
          recipient_email: 'jose@svdp.us',
          submitted_at: new Date('2026-06-25T12:00:00.000Z'),
          questions: [],
          responses: [],
        },
      ],
    });
    const files = await buildExport('camp-1');
    const recipientFile = files.find((f) => !f.path.endsWith('_summary.md'));
    // accents stripped (é → removed), spaces → hyphens, slash removed.
    expect(recipientFile?.path).toBe('docs/operations-intel/dr3-intel-2026-06/jos-dangelo-smith.md');
    expect(recipientFile?.path).not.toContain('/jose'); // no stray segment
    expect(recipientFile?.path.split('/').length).toBe(4); // dir depth fixed, no injected slashes
  });
});
