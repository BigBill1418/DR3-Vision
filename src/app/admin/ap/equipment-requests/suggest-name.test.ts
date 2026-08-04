// ADR-0075 — the resolve panel stops seeding invoice prose into asset names.
//
// The approver's free-text description is a description of a JOB. The asset name
// is the label an approver will pick from a list, forever. The old suggestion
// took the first 60 characters of the first line and offered them as the name,
// and production shows what that produces: an equipment request reading "Fix and
// repair trailer: 53489, 5340, 35, 282859 going to Oregon Stores" is a work order
// covering FOUR trailers.
//
// An EMPTY field is the right answer whenever the text looks like a job rather
// than a thing — a pre-filled bad name is worse than no name, because it asks the
// resolver to approve a suggestion instead of writing an answer.

import { describe, it, expect } from 'vitest';
import { suggestName } from './EquipmentRequestsClient';

describe('suggestName', () => {
  it('passes through a description that is already just a name', () => {
    expect(suggestName('Terex machine')).toBe('Terex machine');
    expect(suggestName('trailer 540010')).toBe('trailer 540010');
  });

  it('EMPTIES the field for the real 2026-08-04 work order', () => {
    expect(
      suggestName('Fix and repair trailer: 53489, 5340, 35, 282859 going to Oregon Stores'),
    ).toBe('');
  });

  it('empties the field for any comma list — several units, no single name', () => {
    expect(suggestName('trailer 95, trailer 5308')).toBe('');
  });

  it('empties the field for anything sentence-length', () => {
    expect(
      suggestName('The yellow Hyster forklift that lives by the north dock door at Woodland'),
    ).toBe('');
  });

  it('strips leading work-order verbs, including chained ones', () => {
    expect(suggestName('fix trailer 95')).toBe('trailer 95');
    expect(suggestName('Repair: baler 12')).toBe('baler 12');
    expect(suggestName('Fix and repair trailer 540010')).toBe('trailer 540010');
    expect(suggestName('Serviced forklift 7')).toBe('forklift 7');
  });

  it('takes the first line only', () => {
    expect(suggestName('Terex machine\nit has been down since Tuesday')).toBe('Terex machine');
  });

  it('never returns whitespace or a bare separator', () => {
    expect(suggestName('   ')).toBe('');
    expect(suggestName('fix')).toBe('');
    expect(suggestName('repair:')).toBe('');
  });
});
