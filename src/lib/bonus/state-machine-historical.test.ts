// Tests for the new historical_imported state transitions per ADR-0023.
// Drop in as tests/unit/bonus/state-machine-historical.test.ts.

import { describe, expect, it } from 'vitest';

import {
  ADMIN_ONLY_TRANSITIONS,
  ALLOWED_TRANSITIONS,
  EDITABLE_STATES,
  isAdminOnlyTransition,
  isTransitionAllowed,
  TransitionError,
  TransitionForbiddenError,
  transitionMonth,
  type BonusMonthDb,
  type BonusMonthRow,
} from '@/lib/bonus/state-machine';

// ─── Fixture: in-memory BonusMonthDb that records state changes + audit. ───
function makeDb(initial: BonusMonthRow): BonusMonthDb {
  let row = { ...initial };
  const audit: Array<Record<string, unknown>> = [];

  const db: BonusMonthDb = {
    bonusPayPeriod: {
      async findUnique({ where }) {
        if ('id' in where && where.id === row.id) return { ...row };
        return null;
      },
      async findFirst() {
        return { ...row };
      },
      async findMany() {
        return [{ ...row }];
      },
      async create({ data }) {
        return { id: 'new', site_id: data.site_id, period_start: data.period_start, period_end: data.period_end, state: data.state };
      },
      async update({ where, data }) {
        if (where.id === row.id) {
          row = { ...row, ...data };
          return { ...row };
        }
        throw new Error('not found');
      },
    },
    auditLog: {
      async create({ data }) {
        audit.push(data);
        return data;
      },
    },
    async $transaction(fn) {
      return fn(db);
    },
  };
  // attach for inspection
  (db as unknown as { __audit: Array<Record<string, unknown>> }).__audit = audit;
  return db;
}

const baseRow: BonusMonthRow = {
  id: 'pp_test',
  site_id: 'site_w',
  period_start: new Date('2025-01-07'),
  period_end: new Date('2025-01-20'),
  state: 'draft',
};

describe('historical_imported state transitions (ADR-0023)', () => {
  describe('ALLOWED_TRANSITIONS table', () => {
    it('exposes historical_imported as a state key', () => {
      expect(ALLOWED_TRANSITIONS).toHaveProperty('historical_imported');
    });

    it('declares draft -> historical_imported legal', () => {
      expect(isTransitionAllowed('draft', 'historical_imported')).toBe(true);
    });

    it('declares skipped -> historical_imported legal', () => {
      expect(isTransitionAllowed('skipped', 'historical_imported')).toBe(true);
    });

    it('declares historical_imported -> amended as the single out-edge', () => {
      expect(ALLOWED_TRANSITIONS.historical_imported).toEqual(['amended']);
      expect(isTransitionAllowed('historical_imported', 'amended')).toBe(true);
    });

    it('rejects historical_imported -> paid (must amend first)', () => {
      expect(isTransitionAllowed('historical_imported', 'paid')).toBe(false);
    });

    it('rejects historical_imported -> signed (must amend first)', () => {
      expect(isTransitionAllowed('historical_imported', 'signed')).toBe(false);
    });

    it('preserves existing draft out-edges (pending_signatures, skipped)', () => {
      expect(isTransitionAllowed('draft', 'pending_signatures')).toBe(true);
      expect(isTransitionAllowed('draft', 'skipped')).toBe(true);
    });
  });

  describe('ADMIN_ONLY_TRANSITIONS set', () => {
    it('flags draft->historical_imported as admin-only', () => {
      expect(isAdminOnlyTransition('draft', 'historical_imported')).toBe(true);
    });

    it('flags skipped->historical_imported as admin-only', () => {
      expect(isAdminOnlyTransition('skipped', 'historical_imported')).toBe(true);
    });

    it('does NOT flag historical_imported->amended as admin-only (uses existing amendment auth)', () => {
      expect(isAdminOnlyTransition('historical_imported', 'amended')).toBe(false);
    });

    it('preserves existing draft->skipped admin-only edge', () => {
      expect(ADMIN_ONLY_TRANSITIONS.has('draft->skipped')).toBe(true);
    });
  });

  describe('EDITABLE_STATES', () => {
    it('does NOT include historical_imported (entries are locked, must amend first)', () => {
      expect(EDITABLE_STATES).not.toContain('historical_imported');
    });
  });

  describe('transitionMonth execution', () => {
    it('admin can drive draft -> historical_imported', async () => {
      const db = makeDb({ ...baseRow, state: 'draft' });
      const result = await transitionMonth({
        db,
        monthId: baseRow.id,
        to: 'historical_imported',
        actor: { userId: 'u_bill', isAdmin: true },
      });
      expect(result.state).toBe('historical_imported');
    });

    it('admin can drive skipped -> historical_imported', async () => {
      const db = makeDb({ ...baseRow, state: 'skipped' });
      const result = await transitionMonth({
        db,
        monthId: baseRow.id,
        to: 'historical_imported',
        actor: { userId: 'u_bill', isAdmin: true },
      });
      expect(result.state).toBe('historical_imported');
    });

    it('non-admin manager is forbidden from driving draft -> historical_imported', async () => {
      const db = makeDb({ ...baseRow, state: 'draft' });
      await expect(
        transitionMonth({
          db,
          monthId: baseRow.id,
          to: 'historical_imported',
          actor: { userId: 'u_janette', isAdmin: false },
        }),
      ).rejects.toBeInstanceOf(TransitionForbiddenError);
    });

    it('system actor (no userId) can drive the import transition (seed runtime)', async () => {
      const db = makeDb({ ...baseRow, state: 'draft' });
      const result = await transitionMonth({
        db,
        monthId: baseRow.id,
        to: 'historical_imported',
        actor: { label: 'system:historical-import' },
      });
      expect(result.state).toBe('historical_imported');
    });

    it('historical_imported -> amended works without admin (uses existing amendment workflow)', async () => {
      const db = makeDb({ ...baseRow, state: 'historical_imported' });
      const result = await transitionMonth({
        db,
        monthId: baseRow.id,
        to: 'amended',
        actor: { userId: 'u_bill', isAdmin: true },
      });
      expect(result.state).toBe('amended');
    });

    it('rejects historical_imported -> paid as illegal', async () => {
      const db = makeDb({ ...baseRow, state: 'historical_imported' });
      await expect(
        transitionMonth({
          db,
          monthId: baseRow.id,
          to: 'paid',
          actor: { userId: 'u_bill', isAdmin: true },
        }),
      ).rejects.toBeInstanceOf(TransitionError);
    });

    it('writes an audit row for every successful transition', async () => {
      const db = makeDb({ ...baseRow, state: 'draft' });
      await transitionMonth({
        db,
        monthId: baseRow.id,
        to: 'historical_imported',
        actor: { userId: 'u_bill', isAdmin: true, label: null },
      });
      const audit = (db as unknown as { __audit: Array<Record<string, unknown>> }).__audit;
      expect(audit).toHaveLength(1);
      const entry = audit[0]!;
      expect(entry['before']).toEqual({ state: 'draft' });
      expect(entry['after']).toEqual({ state: 'historical_imported' });
      expect(entry['table_name']).toBe('bonus_pay_periods');
    });
  });
});
