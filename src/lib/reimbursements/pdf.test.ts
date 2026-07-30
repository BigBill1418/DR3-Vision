// ADR-0068 deferred item 1 — the stamped reimbursement decision PDF.
//
// These tests are built around the one thing the artefact exists to do: assert an
// independent second signature. So they check BOTH directions — that a legitimate
// dual-signed row renders both signatures in Pacific, and that every row which
// cannot evidence the claim is REFUSED rather than stamped. A stamper that
// happily prints "approved by two people" over a self-approval would be worse
// than the missing feature it replaces.
//
// No real Chromium: the renderer is injected, as in src/lib/ap/stamp.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  assertDualSignature,
  buildReimbursementDecisionHtml,
  pdfBeneficiaryLabel,
  reimbursementDecisionAttachment,
  reimbursementStampLine,
  renderReimbursementDecisionPdf,
  ReimbursementPdfUnprovableError,
  segregationStatementHtml,
  type ReimbursementDecisionPdfInput,
} from './pdf';

// 2026-07-20 12:15 PDT and 2026-07-21 09:30 PDT — deliberately chosen so the UTC
// instant lands on a DIFFERENT calendar day than Pacific for the first one
// (19:15Z same day) and so a UTC render would show the wrong hour for both.
const SUBMITTED_AT = new Date('2026-07-20T19:15:00Z');
const APPROVED_AT = new Date('2026-07-21T16:30:00Z');

function row(over: Partial<ReimbursementDecisionPdfInput> = {}): ReimbursementDecisionPdfInput {
  return {
    id: 'reimb-7',
    status: 'approved',
    amount_cents: 4285,
    expense_date: new Date('2026-07-18T12:00:00.000Z'),
    category: 'supplies',
    purpose: 'Box cutters and tape for the sort line',
    site: { name: 'Woodland' },
    submitted_by: 'u_jt',
    submitted_at: SUBMITTED_AT,
    submitter: { name: 'Janette Tomas' },
    second_approver_id: 'u_mg',
    second_approver: { name: 'Morena Garcia' },
    second_approved_at: APPROVED_AT,
    employee_user_id: 'u_floor',
    employee_user: { name: 'Alex Rivera' },
    employee_name_freeform: null,
    decision_note: null,
    ...over,
  };
}

/** Deterministic stand-in for the Playwright renderer: the HTML IS the "PDF". */
function stubRenderer() {
  return vi.fn(async (html: string): Promise<Buffer> => Buffer.from(html));
}

describe('reimbursementStampLine — both signatures, both Pacific', () => {
  it('names the submitter as SUBMITTING and only the approver as APPROVING', () => {
    const line = reimbursementStampLine(row());
    expect(line).toMatch(/^Submitted by Janette Tomas on .+ PT · Approved by Morena Garcia on /);
    expect(line).toContain('via DR3-Vision — Site: Woodland');
    // The AP stamper would have rendered "Approved by Janette …" here. That is the
    // manufactured-evidence shape ADR-0068 exists to remove.
    expect(line).not.toMatch(/Approved by Janette/);
  });

  it('renders both timestamps in Pacific, not UTC', () => {
    const line = reimbursementStampLine(row());
    // 19:15Z = 12:15 PM PDT; 16:30Z = 9:30 AM PDT.
    expect(line).toContain('12:15');
    expect(line).toContain('9:30');
    expect(line).not.toContain('19:15');
    expect(line).not.toContain('16:30');
    // Both instants are labelled, so neither can be read as a bare UTC stamp.
    expect(line.match(/ PT/g)?.length).toBe(2);
  });
});

describe('the segregation-of-duties statement is checked, not decorative', () => {
  it('roster beneficiary: claims the id comparison it actually made', () => {
    const html = segregationStatementHtml(row());
    expect(html).toContain('Two signatures, two different people.');
    expect(html).toContain('that submission is the first signature and is not an approval');
    expect(html).toContain('reimbursement_second_approver_not_submitter');
    expect(html).toContain('the two ids differ on this record');
  });

  it('free-text beneficiary: does NOT claim an id check that is impossible', () => {
    const html = segregationStatementHtml(
      row({
        employee_user_id: null,
        employee_user: null,
        employee_name_freeform: 'A. Rivera',
      }),
    );
    expect(html).not.toContain('the two ids differ');
    expect(html).toContain('entered as free text');
    expect(html).toContain('enforced at submission by name matching');
  });

  it('escapes a hostile name rather than emitting markup', () => {
    const html = segregationStatementHtml(
      row({ submitter: { name: '<script>alert(1)</script>' } }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('assertDualSignature — REFUSES every unprovable row', () => {
  const cases: Array<[string, Partial<ReimbursementDecisionPdfInput>, RegExp]> = [
    ['not approved (held)', { status: 'held' }, /is held, not approved/],
    ['not approved (rejected)', { status: 'rejected' }, /is rejected, not approved/],
    [
      'approved with no second approver id',
      { second_approver_id: null },
      /carries no second approver/,
    ],
    [
      'approved with no approval instant',
      { second_approved_at: null },
      /carries no second approver/,
    ],
    [
      'approved by its own submitter',
      { second_approver_id: 'u_jt' },
      /approved by its own submitter/,
    ],
    [
      'approved by the beneficiary',
      { second_approver_id: 'u_floor' },
      /approved by the person being reimbursed/,
    ],
  ];
  for (const [label, over, expected] of cases) {
    it(`throws on: ${label}`, () => {
      expect(() => assertDualSignature(row(over))).toThrow(ReimbursementPdfUnprovableError);
      expect(() => assertDualSignature(row(over))).toThrow(expected);
    });
  }

  it('accepts the legitimate case (a constraint that refuses everything is useless)', () => {
    expect(() => assertDualSignature(row())).not.toThrow();
  });

  it('does not refuse a free-text beneficiary whose name resembles the approver', () => {
    // The id comparison is impossible here; refusing would block every free-text
    // reimbursement. The document says so instead — see the statement test above.
    expect(() =>
      assertDualSignature(
        row({ employee_user_id: null, employee_user: null, employee_name_freeform: 'Morena' }),
      ),
    ).not.toThrow();
  });
});

describe('buildReimbursementDecisionHtml — the fields Mary pays from', () => {
  it('carries beneficiary, amount, expense date, category, purpose and site', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).toContain('Alex Rivera');
    expect(html).toContain('$42.85');
    expect(html).toContain('July 18, 2026'); // the expense calendar day, not the decision day
    expect(html).toContain('Supplies');
    expect(html).toContain('Box cutters and tape for the sort line');
    expect(html).toContain('Woodland');
    expect(html).toContain('Employee Reimbursement Approval');
    expect(html).toContain('APPROVED');
  });

  it('labels the two signature rows as first and second', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).toContain('Submitted by (first signature)');
    expect(html).toContain('Approved by (second signature)');
  });

  it('shows the approver note when there is one, and no empty note row when there is not', () => {
    expect(buildReimbursementDecisionHtml(row())).not.toContain('Approver note');
    const withNote = buildReimbursementDecisionHtml(row({ decision_note: 'Split with Eugene.' }));
    expect(withNote).toContain('Approver note');
    expect(withNote).toContain('Split with Eugene.');
  });

  it('references no external asset (the renderer aborts anything not data:/about:)', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
  });

  it('uses DR3 green, never SVdP red', () => {
    const html = buildReimbursementDecisionHtml(row());
    expect(html).toContain('#00524C');
    expect(html.toLowerCase()).not.toContain('#c8102e');
  });
});

describe('renderReimbursementDecisionPdf — deterministic sha256 tamper record', () => {
  it('hashes the rendered bytes and names the file after the request', async () => {
    const renderer = stubRenderer();
    const a = await renderReimbursementDecisionPdf(row(), renderer);
    const b = await renderReimbursementDecisionPdf(row(), renderer);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256); // same row ⇒ same bytes ⇒ same tamper record
    expect(a.filename).toBe('reimbursement-decision-reimb-7.pdf');
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it('a different approver produces a different hash', async () => {
    const renderer = stubRenderer();
    const a = await renderReimbursementDecisionPdf(row(), renderer);
    const b = await renderReimbursementDecisionPdf(
      row({ second_approver: { name: 'Rick Alvarez' }, second_approver_id: 'u_rk' }),
      renderer,
    );
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('never calls the renderer on an unprovable row', async () => {
    const renderer = stubRenderer();
    await expect(
      renderReimbursementDecisionPdf(row({ second_approver_id: 'u_jt' }), renderer),
    ).rejects.toThrow(ReimbursementPdfUnprovableError);
    expect(renderer).not.toHaveBeenCalled();
  });
});

describe('reimbursementDecisionAttachment — fail-soft, never fail-silent', () => {
  it('returns the notifyStaff attachment shape on success', async () => {
    const out = await reimbursementDecisionAttachment(row(), stubRenderer());
    expect(out.problem).toBeNull();
    expect(out.attachment?.filename).toBe('reimbursement-decision-reimb-7.pdf');
    expect(out.attachment?.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(out.attachment?.buffer)).toBe(true);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a renderer failure as a problem sentence instead of throwing', async () => {
    const boom = vi.fn(async (): Promise<Buffer> => {
      throw new Error('chromium died');
    });
    const out = await reimbursementDecisionAttachment(row(), boom);
    expect(out.attachment).toBeNull();
    expect(out.sha256).toBeNull();
    expect(out.problem).toContain('chromium died');
    expect(out.problem).toContain('no stamped artefact is attached');
  });

  it('reports an unprovable row as a problem sentence rather than stamping it', async () => {
    const out = await reimbursementDecisionAttachment(
      row({ second_approver_id: 'u_floor' }),
      stubRenderer(),
    );
    expect(out.attachment).toBeNull();
    expect(out.problem).toContain('approved by the person being reimbursed');
  });
});

describe('pdfBeneficiaryLabel', () => {
  it('prefers the roster name, falls back to free text, then to a marker', () => {
    expect(pdfBeneficiaryLabel(row())).toBe('Alex Rivera');
    expect(
      pdfBeneficiaryLabel(
        row({ employee_user: null, employee_user_id: null, employee_name_freeform: 'A. Rivera' }),
      ),
    ).toBe('A. Rivera');
    expect(
      pdfBeneficiaryLabel(
        row({ employee_user: null, employee_user_id: null, employee_name_freeform: null }),
      ),
    ).toBe('(unnamed)');
  });
});
