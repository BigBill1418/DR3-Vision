// ADR-0126 — the decided-but-unmailed predicate.
//
// These are the pins that keep the sweep honest. The headline one is the LAST
// describe block: a fingerprint that changes when a NEW row gets stuck. A dedup
// key that fails that test is decorative — it either pages every single day for a
// row nobody can act on today, or it swallows a brand-new failure inside the
// previous alert's cooldown. Both were live risks in the incident this ADR closes.

import { describe, expect, it } from 'vitest';
import {
  DECIDED_STATUSES,
  DECISION_MAIL_GRACE_MS,
  decisionMailStuckFingerprint,
  decisionMailUnsentWhere,
  isDecisionMailStuck,
  isDecisionMailUnsent,
} from './decision-mail';

const NOW = new Date('2026-08-25T13:00:00.000Z');
/** `ms` before NOW. */
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('isDecisionMailUnsent', () => {
  it('is true for a decided row with no mail stamp', () => {
    for (const status of DECIDED_STATUSES) {
      expect(
        isDecisionMailUnsent({
          status,
          decision_mail_sent_at: null,
          decision_mail_filed_out_of_band_at: null,
        }),
      ).toBe(true);
    }
  });

  it('is false once the mail stamp lands', () => {
    expect(
      isDecisionMailUnsent({
        status: 'rejected',
        decision_mail_sent_at: NOW,
        decision_mail_filed_out_of_band_at: null,
      }),
    ).toBe(false);
  });

  // ADR-0129 D1 — the BN-1 rows: Mary filed the decisions with accounting by
  // hand, so no mail is missing and re-sending would duplicate her filing.
  // Stamping decision_mail_sent_at would be a lie (no transport ever confirmed
  // a send — ADR-0117 made that stamp a fact, not a promise). The out-of-band
  // stamp is its own truthful fact: a person confirmed delivery happened
  // outside Vision's mail path.
  it('is false once a person confirms the decision was filed out of band', () => {
    expect(
      isDecisionMailUnsent({
        status: 'approved',
        decision_mail_sent_at: null,
        decision_mail_filed_out_of_band_at: NOW,
      }),
    ).toBe(false);
  });

  it('ignores every non-terminal status', () => {
    // pending_second_approval is the one that matters: a >= $1,000 first approval
    // legitimately has no decision mail yet, and reporting it would make the sweep
    // noise from its first run.
    for (const status of ['pending', 'pending_review', 'pending_second_approval', 'quarantined']) {
      expect(
        isDecisionMailUnsent({
          status,
          decision_mail_sent_at: null,
          decision_mail_filed_out_of_band_at: null,
        }),
      ).toBe(false);
    }
  });
});

describe('isDecisionMailStuck (grace)', () => {
  it('does NOT count a send that may still be in flight', () => {
    const row = {
      status: 'rejected',
      decided_at: ago(60_000),
      decision_mail_sent_at: null,
      decision_mail_filed_out_of_band_at: null,
    };
    expect(isDecisionMailStuck(row, NOW)).toBe(false);
  });

  it('counts a row once it is past the grace window', () => {
    const row = {
      status: 'rejected',
      decided_at: ago(DECISION_MAIL_GRACE_MS + 1000),
      decision_mail_sent_at: null,
      decision_mail_filed_out_of_band_at: null,
    };
    expect(isDecisionMailStuck(row, NOW)).toBe(true);
  });

  it('counts a decided row whose decided_at is NULL rather than hiding it', () => {
    // Should be impossible (decide writes both in one update). If it happens we
    // cannot tell when it was decided — and "we cannot tell" must surface, not
    // fall through the grace check and stay invisible forever.
    const row = {
      status: 'approved',
      decided_at: null,
      decision_mail_sent_at: null,
      decision_mail_filed_out_of_band_at: null,
    };
    expect(isDecisionMailStuck(row, NOW)).toBe(true);
  });

  it('never counts a row that was actually mailed, however old', () => {
    const row = {
      status: 'approved',
      decided_at: ago(90 * 86_400_000),
      decision_mail_sent_at: ago(90 * 86_400_000),
      decision_mail_filed_out_of_band_at: null,
    };
    expect(isDecisionMailStuck(row, NOW)).toBe(false);
  });

  it('never counts a row confirmed filed out of band, however old the decision', () => {
    const row = {
      status: 'approved',
      decided_at: ago(90 * 86_400_000),
      decision_mail_sent_at: null,
      decision_mail_filed_out_of_band_at: ago(1000),
    };
    expect(isDecisionMailStuck(row, NOW)).toBe(false);
  });
});

describe('decisionMailUnsentWhere', () => {
  it('selects exactly the two terminal statuses with a null stamp', () => {
    expect(decisionMailUnsentWhere()).toEqual({
      status: { in: ['approved', 'rejected'] },
      decision_mail_sent_at: null,
      decision_mail_filed_out_of_band_at: null,
    });
  });

  it('does not push the grace window into the query', () => {
    // A `decided_at: { lte }` clause here would silently drop the NULL-decided_at
    // rows the in-memory predicate deliberately keeps.
    expect(decisionMailUnsentWhere()).not.toHaveProperty('decided_at');
  });
});

describe('decisionMailStuckFingerprint', () => {
  it('is stable for the same set regardless of order', () => {
    expect(decisionMailStuckFingerprint(['b', 'a'])).toBe(decisionMailStuckFingerprint(['a', 'b']));
  });

  it('CHANGES when a new row joins the stuck set', () => {
    // The load-bearing assertion. If these matched, a brand-new stuck decision
    // would be suppressed by the previous alert's cooldown and nobody would be
    // paged about it until the cooldown expired.
    expect(decisionMailStuckFingerprint(['a', 'b'])).not.toBe(
      decisionMailStuckFingerprint(['a', 'b', 'c']),
    );
  });

  it('changes when a row CLEARS, so the next failure is not suppressed', () => {
    expect(decisionMailStuckFingerprint(['a', 'b'])).not.toBe(decisionMailStuckFingerprint(['a']));
  });
});
