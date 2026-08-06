// ADR-0077 D6 — who can open the Terex machine ledger.
//
// The audience is Bill + the two Woodland managers. Three plausible signals do
// NOT select that set, and each of those is pinned here as a negative case,
// because the failure mode is silent: a wrong gate does not error, it just shows
// one machine's invoice history to someone who should not have it.
//
//   - `role === 'manager'` + site reach admits Daven and Kelsey via `all_sites`.
//   - the `ap_approvers` roster admits Shannon.
//   - matching people BY NAME walks into the duplicate-account trap: production
//     carries a SECOND, inactive "Bill Barnard" row with a different email. Every
//     fixture below is keyed on the flag and the email, never the name — and one
//     test exists purely to prove a same-name row with no flag is refused.
//
// The roster mirrors production as read on 2026-08-06.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: unknown = null;
let mockUsers: Record<
  string,
  { can_resolve_equipment_requests: boolean; all_sites: boolean; primary_site_id: string | null }
> = {};

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id && mockUsers[where.id] ? mockUsers[where.id] : null,
      ),
    },
  },
}));

import {
  requireEquipmentLedgerAccess,
  checkEquipmentLedgerAccess,
  ledgerReaches,
} from './auth-helpers';

/** The production roster, keyed by EMAIL + FLAG — never by display name. */
const ROSTER = {
  bill: {
    id: 'u-bill',
    email: 'bill.barnard@svdp.us',
    name: 'Bill Barnard',
    role: 'admin',
    flags: null,
  },
  // The duplicate-account trap: same NAME, no email match, not an admin session.
  billGhost: {
    id: 'u-bill-ops',
    email: 'operations@svdp.us',
    name: 'Bill Barnard',
    role: 'manager',
    flags: { can_resolve_equipment_requests: false, all_sites: false, primary_site_id: null },
  },
  morena: {
    id: 'u-morena',
    email: 'morena.gomez@svdp.us',
    name: 'Morena Gomez',
    role: 'manager',
    flags: { can_resolve_equipment_requests: true, all_sites: false, primary_site_id: WOODLAND },
  },
  janette: {
    id: 'u-janette',
    email: 'janette.tomas@svdp.us',
    name: 'Janette Tomas',
    role: 'manager',
    flags: { can_resolve_equipment_requests: true, all_sites: false, primary_site_id: WOODLAND },
  },
  // HOLDS the flag but is Eugene-scoped — reach, not the flag, excludes him.
  rick: {
    id: 'u-rick',
    email: 'rick.albritton@svdp.us',
    name: 'Rick Albritton',
    role: 'manager',
    flags: { can_resolve_equipment_requests: true, all_sites: false, primary_site_id: EUGENE },
  },
  // An AP APPROVER without the flag. Files invoices; does not decide what assets are.
  shannon: {
    id: 'u-shannon',
    email: 'shannon.rockwell@svdp.us',
    name: 'Shannon Rockwell',
    role: 'manager',
    flags: { can_resolve_equipment_requests: false, all_sites: false, primary_site_id: EUGENE },
  },
  // all_sites managers WITHOUT the flag — the reason role+reach is the wrong gate.
  daven: {
    id: 'u-daven',
    email: 'daven.stetson@svdp.us',
    name: 'Daven Stetson',
    role: 'manager',
    flags: { can_resolve_equipment_requests: false, all_sites: true, primary_site_id: null },
  },
  kelsey: {
    id: 'u-kelsey',
    email: 'kelsey.ruhland@svdp.us',
    name: 'Kelsey Ruhland',
    role: 'manager',
    flags: { can_resolve_equipment_requests: false, all_sites: true, primary_site_id: EUGENE },
  },
  operator: {
    id: 'u-op',
    email: 'floor@svdp.us',
    name: 'Floor Operator',
    role: 'operator',
    flags: { can_resolve_equipment_requests: false, all_sites: false, primary_site_id: WOODLAND },
  },
} as const;

function signIn(who: keyof typeof ROSTER): void {
  const p = ROSTER[who];
  mockSession = { user: { id: p.id, name: p.name, email: p.email, role: p.role } };
  if (p.flags) mockUsers[p.id] = { ...p.flags };
}

/** Can this person open the WOODLAND machine's ledger, end to end? */
async function canOpenWoodlandMachine(who: keyof typeof ROSTER): Promise<boolean> {
  signIn(who);
  const res = await checkEquipmentLedgerAccess();
  if (!res.ok) return false;
  return ledgerReaches(res.ctx, WOODLAND);
}

beforeEach(() => {
  mockSession = null;
  mockUsers = {};
});

describe('the Terex ledger access matrix (ADR-0077 D6)', () => {
  it.each([
    ['bill', true],
    ['morena', true],
    ['janette', true],
  ] as const)('%s CAN open the Woodland machine ledger', async (who, expected) => {
    expect(await canOpenWoodlandMachine(who)).toBe(expected);
  });

  it.each([
    ['rick', 'holds the flag but is Eugene-scoped'],
    ['shannon', 'is an AP approver, which is not this flag'],
    ['daven', 'has all_sites but not the flag'],
    ['kelsey', 'has all_sites but not the flag'],
    ['operator', 'is an operator'],
    ['billGhost', 'is the same NAME with no flag — identity is not the display name'],
  ] as const)('%s CANNOT open it — %s', async (...args) => {
    // args[1] is the reason; it is rendered into the test NAME by %s and is
    // documentation, not an input.
    expect(await canOpenWoodlandMachine(args[0])).toBe(false);
  });

  it('is exactly three people out of the whole roster', async () => {
    const everyone = Object.keys(ROSTER) as (keyof typeof ROSTER)[];
    const allowed: string[] = [];
    for (const who of everyone) {
      mockUsers = {};
      if (await canOpenWoodlandMachine(who)) allowed.push(who);
    }
    expect(allowed.sort()).toEqual(['bill', 'janette', 'morena']);
  });
});

describe('the gate mechanics', () => {
  it('401s with no session', async () => {
    const res = await checkEquipmentLedgerAccess();
    expect(res).toEqual({ ok: false, status: 401 });
  });

  it('403s an ungranted manager', async () => {
    signIn('shannon');
    const res = await checkEquipmentLedgerAccess();
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it('throws a Response (not a value) from the require form', async () => {
    signIn('operator');
    await expect(requireEquipmentLedgerAccess()).rejects.toBeInstanceOf(Response);
  });

  it('reads the flag FRESH from Postgres, never from the JWT', async () => {
    // Session says manager; the JWT carries no flag. Revoking it in the DB must
    // take effect on the very next request.
    signIn('morena');
    expect(await canOpenWoodlandMachine('morena')).toBe(true);

    mockUsers['u-morena'] = {
      can_resolve_equipment_requests: false,
      all_sites: false,
      primary_site_id: WOODLAND,
    };
    const res = await checkEquipmentLedgerAccess();
    expect(res.ok).toBe(false);
  });

  it('marks only the admin as admin — the deep link is admin-only', async () => {
    signIn('bill');
    const asAdmin = await requireEquipmentLedgerAccess();
    expect(asAdmin.isAdmin).toBe(true);
    expect(asAdmin.via).toBe('admin');

    signIn('morena');
    const asManager = await requireEquipmentLedgerAccess();
    expect(asManager.isAdmin).toBe(false);
    expect(asManager.via).toBe('can_resolve_equipment_requests');
  });
});

describe('ledgerReaches — reach comes from the ASSET, not the URL', () => {
  it('a Woodland manager cannot reach a Eugene asset by editing the [site] segment', async () => {
    signIn('morena');
    const ctx = await requireEquipmentLedgerAccess();
    expect(ledgerReaches(ctx, WOODLAND)).toBe(true);
    expect(ledgerReaches(ctx, EUGENE)).toBe(false);
  });

  it('a NULL primary_site_id reaches NOTHING — never "everywhere"', async () => {
    mockSession = { user: { id: 'u-x', name: 'X', email: 'x@svdp.us', role: 'manager' } };
    mockUsers['u-x'] = {
      can_resolve_equipment_requests: true,
      all_sites: false,
      primary_site_id: null,
    };
    const ctx = await requireEquipmentLedgerAccess();
    expect(ledgerReaches(ctx, WOODLAND)).toBe(false);
    expect(ledgerReaches(ctx, EUGENE)).toBe(false);
  });

  it('an admin reaches both sites', async () => {
    signIn('bill');
    const ctx = await requireEquipmentLedgerAccess();
    expect(ledgerReaches(ctx, WOODLAND)).toBe(true);
    expect(ledgerReaches(ctx, EUGENE)).toBe(true);
  });
});
