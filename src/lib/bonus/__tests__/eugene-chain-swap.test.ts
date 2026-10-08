// ADR-0019.7 — Eugene signature-chain slot swap (Bill, 2026-10-07, option "a").
//
// Drives the REAL signature path (`recordSignature`) against a chain built from
// the REAL seed CSV (`prisma/seed/bonus_signature_chains.csv`), so the test fails
// if the seed and the decision disagree:
//   Eugene facility = Patrick Dills, override = [Bill, Rick]
//   Eugene ops      = Rick Albritton, override = [Bill]
//   auto-override   = Bill (both sites)
//   Woodland        = unchanged (Janette / Morena).
//
// Patrick is a Eugene BonusEmployee (linked `user_id`, row inactive, last entry
// 2026-01-14 in prod). He signs facility on any period that holds none of his
// entries; a period holding his own entries is still refused by the ADR-0019.3 §2
// guard and routes to the facility override chain (Bill or Rick).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/observability/metrics', () => ({
  bonusPayPeriodsByState: { inc: vi.fn(), dec: vi.fn() },
}));

import {
  recordSignature,
  type BonusMonthSignatureRow,
  type SignatureDb,
  type SignerContext,
} from '../signatures';
import {
  clearSignatureChainCache,
  getSignatureChain,
  type SignatureChainDb,
} from '../signature-chain';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SITE = { woodland: 'site-woodland', eugene: 'site-eugene' } as const;

/** Minimal RFC-4180 line splitter (quoted fields may contain commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** user id = email local part, so assertions read as names. */
const uid = (email: string) => email.trim().split('@')[0]!;

const csv = readFileSync(join(ROOT, 'prisma/seed/bonus_signature_chains.csv'), 'utf8')
  .trim()
  .split('\n');
const header = splitCsvLine(csv[0]!);
const chainRows = new Map(
  csv.slice(1).map((l) => {
    const c = splitCsvLine(l);
    const get = (k: string) => c[header.indexOf(k)]!;
    return [
      get('site_code'),
      {
        facility_signer_user_id: uid(get('facility_signer_email')),
        facility_override_actor_ids: get('facility_override_actor_emails')
          .split(',')
          .map(uid)
          .join(','),
        ops_signer_user_id: uid(get('ops_signer_email')),
        ops_override_actor_ids: get('ops_override_actor_emails').split(',').map(uid).join(','),
        auto_override_actor_user_id: uid(get('auto_override_actor_email')),
      },
    ] as const;
  }),
);

const chainDb: SignatureChainDb = {
  bonusSignatureChain: {
    findUnique: async ({ where }) =>
      where.site_id === SITE.eugene
        ? chainRows.get('eugene')!
        : where.site_id === SITE.woodland
          ? chainRows.get('woodland')!
          : null,
  },
};

const CONFLICTED = 'period-2025-01-07'; // holds Patrick's own historical entries
const P21 = 'period-2026-09-29'; // Period 21: none of his entries

let row: BonusMonthSignatureRow & Record<string, unknown>;
function makeRow(id: string, site: string): typeof row {
  return {
    id,
    site_id: site,
    period_start: new Date('2026-09-29T00:00:00Z'),
    period_end: new Date('2026-10-12T00:00:00Z'),
    state: 'pending_signatures',
    facility_signed_by_user_id: null,
    facility_signed_at: null,
    ops_signed_by_user_id: null,
    ops_signed_at: null,
    total_payout_cents: null,
  };
}

function makeDb(): SignatureDb {
  const db: SignatureDb = {
    bonusPayPeriod: {
      findFirst: async ({ where }) =>
        row.id === where.id && (where.site_id === undefined || row.site_id === where.site_id)
          ? { ...row }
          : null,
      update: async ({ data }) => {
        Object.assign(row, data);
        return { ...row };
      },
    },
    bonusDailyEntry: {
      findMany: async () => [
        { entry_date: new Date(Date.UTC(2026, 9, 1)), mattress_count: 70, saves: 0 },
      ],
      findFirst: async ({ where }) =>
        where.bonus_pay_period_id === CONFLICTED && where.bonus_employee.user_id === 'patrick.dills'
          ? { bonus_employee_id: 'be-patrick', bonus_employee: { full_name: 'Patrick Dills' } }
          : null,
    },
    processorBonusRule: {
      findMany: async () => [
        {
          id: 'rule',
          threshold_low: 50,
          rate_low: { toString: () => '1.0000' },
          threshold_high: 100,
          rate_high: { toString: () => '0.2500' },
          effective_date: new Date(Date.UTC(2026, 0, 1)),
          end_date: null,
        },
      ],
    },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn) => fn(db),
  };
  return db;
}

const person = (
  id: string,
  site: string,
  role: 'manager' | 'admin' = 'manager',
): SignerContext => ({
  userId: id,
  role,
  primarySiteId: role === 'admin' ? null : site,
  siteId: site,
});
const patrick = person('patrick.dills', SITE.eugene);
const rick = person('rick.albritton', SITE.eugene);
const bill = person('bill.barnard', SITE.eugene, 'admin');
const janetteAtEugene = person('janette.tomas', SITE.eugene);

const sign = (signer: SignerContext, monthId: string, onBehalfOf?: 'facility' | 'ops') =>
  recordSignature({
    db: makeDb(),
    chainDb,
    monthId,
    signer,
    ...(onBehalfOf ? { onBehalfOf, overrideReason: 'test override' } : {}),
  });

beforeEach(() => {
  clearSignatureChainCache(chainDb);
  row = makeRow(P21, SITE.eugene);
});

describe('the seeded chains', () => {
  it('Eugene: facility Patrick (override Bill, Rick); ops Rick (override Bill); auto Bill', async () => {
    const c = await getSignatureChain(SITE.eugene, chainDb);
    expect(c.facility_signer_user_id).toBe('patrick.dills');
    expect([...c.facility_override_actor_user_ids].sort()).toEqual([
      'bill.barnard',
      'rick.albritton',
    ]);
    expect(c.ops_signer_user_id).toBe('rick.albritton');
    expect(c.ops_override_actor_user_ids).toEqual(['bill.barnard']);
    expect(c.auto_override_actor_user_id).toBe('bill.barnard');
  });

  it('Woodland is unchanged: facility Janette (override Bill, Morena); ops Morena (override Bill)', async () => {
    const c = await getSignatureChain(SITE.woodland, chainDb);
    expect(c.facility_signer_user_id).toBe('janette.tomas');
    expect([...c.facility_override_actor_user_ids].sort()).toEqual([
      'bill.barnard',
      'morena.gomez',
    ]);
    expect(c.ops_signer_user_id).toBe('morena.gomez');
    expect(c.ops_override_actor_user_ids).toEqual(['bill.barnard']);
    expect(c.auto_override_actor_user_id).toBe('bill.barnard');
  });
});

describe('Period 21 shape (no entries of Patrick)', () => {
  it('Patrick signs the facility slot, although he is a Eugene BonusEmployee', async () => {
    expect(await sign(patrick, P21)).toMatchObject({ ok: true, slot: 'facility' });
    expect(row.facility_signed_by_user_id).toBe('patrick.dills');
  });

  it('Rick signs the ops slot, and the period becomes fully signed', async () => {
    await sign(patrick, P21);
    expect(await sign(rick, P21)).toMatchObject({ ok: true, slot: 'ops', fullySigned: true });
    expect(row.ops_signed_by_user_id).toBe('rick.albritton');
  });

  it('a non-signer has no natural slot', async () => {
    expect(await sign(janetteAtEugene, P21)).toMatchObject({ ok: false, reason: 'no_slot' });
  });
});

describe('override rules', () => {
  it('facility may be overridden by Rick or Bill', async () => {
    expect(await sign(rick, P21, 'facility')).toMatchObject({ ok: true, override: true });
    row = makeRow(P21, SITE.eugene);
    expect(await sign(bill, P21, 'facility')).toMatchObject({ ok: true, override: true });
  });

  it('ops may be overridden by Bill only — not by Patrick', async () => {
    expect(await sign(patrick, P21, 'ops')).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(await sign(bill, P21, 'ops')).toMatchObject({ ok: true, override: true });
  });

  it('a Woodland manager cannot override a Eugene slot', async () => {
    expect(await sign(person('morena.gomez', SITE.eugene), P21, 'facility')).toMatchObject({
      ok: false,
      reason: 'not_authorized',
    });
  });
});

describe('separation of duties still applies to periods holding Patrick’s own entries', () => {
  it('refuses Patrick on facility and routes to Rick’s facility override', async () => {
    row = makeRow(CONFLICTED, SITE.eugene);
    expect(await sign(patrick, CONFLICTED)).toMatchObject({
      ok: false,
      reason: 'sod_excluded',
      slot: 'facility',
    });
    expect(await sign(rick, CONFLICTED, 'facility')).toMatchObject({ ok: true, override: true });
  });
});
