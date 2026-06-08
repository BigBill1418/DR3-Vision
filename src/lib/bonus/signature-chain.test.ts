// T-208 — Signature-chain lookup + site-aware signature service (ADR-0019.2 §2).
//
// The acceptance matrix from the addendum, implemented in full. Identity is
// SOURCED FROM THE CHAIN, never hardcoded (hard rules #2 & #3): both sites'
// chains are fed through an in-memory double mirroring the T-201 seed
// (woodland: facility=Janette / ops=Morena / facility-override [Bill,Morena] /
// ops-override [Bill] / auto=Bill; eugene: facility=Rick / ops=Kelsey /
// facility-override [Bill,Kelsey] / ops-override [Bill] / auto=Bill).
//
// Also locks the lookup itself: override-actor CSV parsing, the shape, the
// not-found error, and per-(db,site) request-lifecycle caching.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/observability/metrics', () => ({
  bonusPayPeriodsByState: { inc: vi.fn(), dec: vi.fn() },
}));

import {
  getSignatureChain,
  getAutoOverrideActor,
  parseOverrideActorIds,
  clearSignatureChainCache,
  SignatureChainNotFoundError,
  type SignatureChainDb,
  type SignatureChainRow,
} from './signature-chain';
import { canSignSlot, canOverrideSlot, type UserPrincipal } from './signatures';

// ── Sites + users (uuids stand in as opaque ids) ────────────────────
const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

const bill: UserPrincipal = { id: 'bill', role: 'admin' };
const kelsey: UserPrincipal = { id: 'kelsey', role: 'admin' };
const janette: UserPrincipal = { id: 'janette', role: 'manager' };
const morena: UserPrincipal = { id: 'morena', role: 'manager' };
const rick: UserPrincipal = { id: 'rick', role: 'manager' };
// T-312 (ADR-0023): Patrick Dills — Eugene manager who is ALSO a BonusEmployee at
// Eugene. Separation of duties: he must occupy NO Eugene signature-chain slot.
const patrick: UserPrincipal = { id: 'patrick', role: 'manager' };

// ── Chain rows mirroring the T-201 seed (emails resolved → uuids, lists
//    re-joined with commas, exactly as the seed stores them) ──────────
const ROWS: Record<string, SignatureChainRow> = {
  [WOODLAND]: {
    facility_signer_user_id: 'janette',
    facility_override_actor_ids: 'bill,morena',
    ops_signer_user_id: 'morena',
    ops_override_actor_ids: 'bill',
    auto_override_actor_user_id: 'bill',
  },
  [EUGENE]: {
    facility_signer_user_id: 'rick',
    facility_override_actor_ids: 'bill,kelsey',
    ops_signer_user_id: 'kelsey',
    ops_override_actor_ids: 'bill',
    auto_override_actor_user_id: 'bill',
  },
};

let queries: string[];
function makeChainDb(): SignatureChainDb {
  return {
    bonusSignatureChain: {
      findUnique: async ({ where }) => {
        queries.push(where.site_id);
        return ROWS[where.site_id] ?? null;
      },
    },
  };
}
let chainDb: SignatureChainDb;

beforeEach(() => {
  queries = [];
  chainDb = makeChainDb();
  clearSignatureChainCache(chainDb);
});

// ────────────────────────────────────────────────────────────────────
// getSignatureChain — shape, parsing, cache, errors
// ────────────────────────────────────────────────────────────────────

describe('getSignatureChain', () => {
  it('returns the resolved Woodland chain with override lists parsed to arrays', async () => {
    const c = await getSignatureChain(WOODLAND, chainDb);
    expect(c).toEqual({
      facility_signer_user_id: 'janette',
      facility_override_actor_user_ids: ['bill', 'morena'],
      ops_signer_user_id: 'morena',
      ops_override_actor_user_ids: ['bill'],
      auto_override_actor_user_id: 'bill',
    });
  });

  it('returns the resolved Eugene chain', async () => {
    const c = await getSignatureChain(EUGENE, chainDb);
    expect(c.facility_signer_user_id).toBe('rick');
    expect(c.facility_override_actor_user_ids).toEqual(['bill', 'kelsey']);
    expect(c.ops_signer_user_id).toBe('kelsey');
    expect(c.ops_override_actor_user_ids).toEqual(['bill']);
  });

  it('caches per (db, site) for the request lifecycle — one query per site', async () => {
    await getSignatureChain(WOODLAND, chainDb);
    await getSignatureChain(WOODLAND, chainDb);
    await getSignatureChain(EUGENE, chainDb);
    await getSignatureChain(EUGENE, chainDb);
    expect(queries).toEqual([WOODLAND, EUGENE]);
  });

  it('clearSignatureChainCache forces a re-read', async () => {
    await getSignatureChain(WOODLAND, chainDb);
    clearSignatureChainCache(chainDb, WOODLAND);
    await getSignatureChain(WOODLAND, chainDb);
    expect(queries).toEqual([WOODLAND, WOODLAND]);
  });

  it('throws SignatureChainNotFoundError for an unseeded site (and evicts so retry works)', async () => {
    await expect(getSignatureChain('site-unknown', chainDb)).rejects.toBeInstanceOf(
      SignatureChainNotFoundError,
    );
    // Evicted: a second call re-queries rather than re-throwing a cached rejection.
    await expect(getSignatureChain('site-unknown', chainDb)).rejects.toBeInstanceOf(
      SignatureChainNotFoundError,
    );
    expect(queries).toEqual(['site-unknown', 'site-unknown']);
  });
});

describe('parseOverrideActorIds', () => {
  it('splits a comma list, trims, drops blanks/trailing comma', () => {
    expect(parseOverrideActorIds('bill,morena')).toEqual(['bill', 'morena']);
    expect(parseOverrideActorIds(' bill , morena , ')).toEqual(['bill', 'morena']);
    expect(parseOverrideActorIds('bill')).toEqual(['bill']);
  });
  it('returns [] for empty/null/undefined', () => {
    expect(parseOverrideActorIds('')).toEqual([]);
    expect(parseOverrideActorIds(null)).toEqual([]);
    expect(parseOverrideActorIds(undefined)).toEqual([]);
  });
});

describe('getAutoOverrideActor — read from chain, never hardcoded (hard rule #3)', () => {
  it('Woodland auto-override actor is Bill (per the chain row)', async () => {
    expect(await getAutoOverrideActor(WOODLAND, chainDb)).toBe('bill');
  });
  it('Eugene auto-override actor is Bill (per the chain row)', async () => {
    expect(await getAutoOverrideActor(EUGENE, chainDb)).toBe('bill');
  });
});

// ────────────────────────────────────────────────────────────────────
// canSignSlot — PRIMARY signer identity (chain-sourced)
// ────────────────────────────────────────────────────────────────────

describe('canSignSlot — primary signer per site (chain-sourced)', () => {
  // Woodland facility = Janette
  it('Janette can sign facility for Woodland', async () => {
    expect(await canSignSlot(janette, 'facility', WOODLAND, chainDb)).toBe(true);
  });
  it('Janette canNOT sign ops for Woodland', async () => {
    expect(await canSignSlot(janette, 'ops', WOODLAND, chainDb)).toBe(false);
  });
  // Woodland ops = Morena
  it('Morena can sign ops for Woodland', async () => {
    expect(await canSignSlot(morena, 'ops', WOODLAND, chainDb)).toBe(true);
  });
  it('Morena canNOT sign facility for Woodland', async () => {
    expect(await canSignSlot(morena, 'facility', WOODLAND, chainDb)).toBe(false);
  });
  // Eugene facility = Rick
  it('Rick can sign facility for Eugene', async () => {
    expect(await canSignSlot(rick, 'facility', EUGENE, chainDb)).toBe(true);
  });
  it('Rick canNOT sign facility for Woodland (cross-site isolation)', async () => {
    expect(await canSignSlot(rick, 'facility', WOODLAND, chainDb)).toBe(false);
  });
  it('Rick canNOT sign ops for Eugene', async () => {
    expect(await canSignSlot(rick, 'ops', EUGENE, chainDb)).toBe(false);
  });
  // Eugene ops = Kelsey
  it('Kelsey can sign ops for Eugene (admin configured as the ops signer)', async () => {
    expect(await canSignSlot(kelsey, 'ops', EUGENE, chainDb)).toBe(true);
  });
  it('Kelsey is NOT the primary ops signer for Woodland (that is Morena)', async () => {
    // Kelsey signing Woodland ops is an OVERRIDE (she is admin), not primary.
    expect(await canSignSlot(kelsey, 'ops', WOODLAND, chainDb)).toBe(false);
    expect(await canOverrideSlot(kelsey, 'ops', WOODLAND, chainDb)).toBe(true);
  });
  it('Kelsey is NOT the primary facility signer at either site', async () => {
    expect(await canSignSlot(kelsey, 'facility', EUGENE, chainDb)).toBe(false);
    expect(await canSignSlot(kelsey, 'facility', WOODLAND, chainDb)).toBe(false);
  });
  // Bill is admin but configured as no slot's primary signer anywhere.
  it('Bill is NOT a primary signer for any slot at either site', async () => {
    expect(await canSignSlot(bill, 'facility', WOODLAND, chainDb)).toBe(false);
    expect(await canSignSlot(bill, 'ops', WOODLAND, chainDb)).toBe(false);
    expect(await canSignSlot(bill, 'facility', EUGENE, chainDb)).toBe(false);
    expect(await canSignSlot(bill, 'ops', EUGENE, chainDb)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// canOverrideSlot — override authority (admin OR in the chain's list)
// ────────────────────────────────────────────────────────────────────

describe('canOverrideSlot — override authority per site (chain-sourced + admin)', () => {
  // Bill (admin, universal): both slots, both sites.
  it('Bill can override either slot at Woodland', async () => {
    expect(await canOverrideSlot(bill, 'facility', WOODLAND, chainDb)).toBe(true);
    expect(await canOverrideSlot(bill, 'ops', WOODLAND, chainDb)).toBe(true);
  });
  it('Bill can override either slot at Eugene', async () => {
    expect(await canOverrideSlot(bill, 'facility', EUGENE, chainDb)).toBe(true);
    expect(await canOverrideSlot(bill, 'ops', EUGENE, chainDb)).toBe(true);
  });
  // Kelsey (admin): both slots both sites by admin rule — even though Woodland's
  // chain does NOT list her.
  it('Kelsey (admin) can override either slot at Woodland (admin rule, not listed)', async () => {
    expect(await canOverrideSlot(kelsey, 'facility', WOODLAND, chainDb)).toBe(true);
    expect(await canOverrideSlot(kelsey, 'ops', WOODLAND, chainDb)).toBe(true);
  });
  it('Kelsey (admin) can override either slot at Eugene', async () => {
    expect(await canOverrideSlot(kelsey, 'facility', EUGENE, chainDb)).toBe(true);
    expect(await canOverrideSlot(kelsey, 'ops', EUGENE, chainDb)).toBe(true);
  });
  // Morena (manager): Woodland facility-override only; NOT Eugene at all.
  it('Morena can override Janette’s facility slot (Woodland) but NOT the ops slot', async () => {
    expect(await canOverrideSlot(morena, 'facility', WOODLAND, chainDb)).toBe(true);
    expect(await canOverrideSlot(morena, 'ops', WOODLAND, chainDb)).toBe(false);
  });
  it('Morena canNOT override Kelsey’s ops slot at Eugene (not in Eugene’s lists)', async () => {
    expect(await canOverrideSlot(morena, 'ops', EUGENE, chainDb)).toBe(false);
    expect(await canOverrideSlot(morena, 'facility', EUGENE, chainDb)).toBe(false);
  });
  // Janette (manager): in no override list anywhere.
  it('Janette has no override authority at Woodland or Eugene', async () => {
    expect(await canOverrideSlot(janette, 'facility', WOODLAND, chainDb)).toBe(false);
    expect(await canOverrideSlot(janette, 'ops', WOODLAND, chainDb)).toBe(false);
    expect(await canOverrideSlot(janette, 'facility', EUGENE, chainDb)).toBe(false);
    expect(await canOverrideSlot(janette, 'ops', EUGENE, chainDb)).toBe(false);
  });
  // Rick (manager): Eugene facility signer, but in no override list → no override.
  it('Rick has no override authority at Eugene (he signs, he does not override)', async () => {
    expect(await canOverrideSlot(rick, 'facility', EUGENE, chainDb)).toBe(false);
    expect(await canOverrideSlot(rick, 'ops', EUGENE, chainDb)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// T-312 (ADR-0023) — Patrick Dills: separation of duties at Eugene
// ────────────────────────────────────────────────────────────────────
//
// Patrick is a NEW Eugene manager who is also a BonusEmployee at Eugene, so he
// must occupy NO Eugene signature-chain slot (facility signer, ops signer, or
// either override-actor list — including the auto-override actor). He gets bonus
// VIEW access (asserted in access.test.ts) but never SIGNING authority.

describe('Patrick Dills (T-312) — absent from every Eugene signature-chain slot', () => {
  it('is not a member of any slot or override list on the resolved Eugene chain', async () => {
    const c = await getSignatureChain(EUGENE, chainDb);
    expect(c.facility_signer_user_id).not.toBe('patrick');
    expect(c.ops_signer_user_id).not.toBe('patrick');
    expect(c.auto_override_actor_user_id).not.toBe('patrick');
    expect(c.facility_override_actor_user_ids).not.toContain('patrick');
    expect(c.ops_override_actor_user_ids).not.toContain('patrick');
  });

  it('cannot sign either slot at Eugene (not the configured primary signer)', async () => {
    expect(await canSignSlot(patrick, 'facility', EUGENE, chainDb)).toBe(false);
    expect(await canSignSlot(patrick, 'ops', EUGENE, chainDb)).toBe(false);
  });

  it('cannot override either slot at Eugene (manager, in no override list)', async () => {
    expect(await canOverrideSlot(patrick, 'facility', EUGENE, chainDb)).toBe(false);
    expect(await canOverrideSlot(patrick, 'ops', EUGENE, chainDb)).toBe(false);
  });
});
