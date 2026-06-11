// Site-aware signer display-name resolution tests.
//
// Locks CLAUDE.md hard rule #2 at the PRESENTATION boundary: the names shown on
// the manager bonus UI come from the per-site signature chain, never hardcoded.
// A Eugene period must resolve to Rick/Kelsey; a Woodland period to
// Janette/Morena. Drives the REAL `resolveSlotSignerNames` through an in-memory
// double mirroring the T-201 seed (same shape used by signature-chain.test.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveSlotSignerNames, type SignerNamesDb } from './signer-names';
import { clearSignatureChainCache } from './signature-chain';
import type { SignatureChainRow } from './signature-chain';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

// Chain rows mirroring the T-201 seed (signer/override columns hold user UUIDs).
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

const USER_NAMES: Record<string, string | null> = {
  janette: 'Janette Tomas',
  morena: 'Morena Gomez',
  rick: 'Rick Albritton',
  kelsey: 'Kelsey Ruhland',
  bill: 'Bill Barnard',
};

// A throwaway db double per test so the chain cache (keyed on the db object via
// WeakMap) never bleeds across cases.
function makeDb(): SignerNamesDb {
  return {
    bonusSignatureChain: {
      findUnique: async ({ where }) => ROWS[where.site_id] ?? null,
    },
    user: {
      findMany: async ({ where }) =>
        where.id.in
          .filter((id) => id in USER_NAMES)
          .map((id) => ({ id, name: USER_NAMES[id] ?? null })),
    },
  };
}

describe('resolveSlotSignerNames — site-aware (hard rule #2)', () => {
  let db: SignerNamesDb;
  beforeEach(() => {
    db = makeDb();
    clearSignatureChainCache(db);
  });

  it('resolves Woodland to Janette Tomas (facility) / Morena Gomez (ops)', async () => {
    const names = await resolveSlotSignerNames(WOODLAND, db);
    expect(names).toEqual({ facility: 'Janette Tomas', ops: 'Morena Gomez' });
  });

  it('resolves Eugene to Rick Albritton (facility) / Kelsey Ruhland (ops)', async () => {
    const names = await resolveSlotSignerNames(EUGENE, db);
    expect(names).toEqual({ facility: 'Rick Albritton', ops: 'Kelsey Ruhland' });
  });

  it('does NOT leak Woodland names into a Eugene period (no hardcoding)', async () => {
    const names = await resolveSlotSignerNames(EUGENE, db);
    expect(names.facility).not.toBe('Janette Tomas');
    expect(names.ops).not.toBe('Morena Gomez');
  });

  it('falls back to the user UUID when a signer name is missing', async () => {
    const sparseDb: SignerNamesDb = {
      bonusSignatureChain: { findUnique: async ({ where }) => ROWS[where.site_id] ?? null },
      user: { findMany: async () => [] }, // no names resolvable
    };
    clearSignatureChainCache(sparseDb);
    const names = await resolveSlotSignerNames(EUGENE, sparseDb);
    expect(names).toEqual({ facility: 'rick', ops: 'kelsey' });
  });

  it('issues a single user.findMany covering both slot signers', async () => {
    let calls = 0;
    let lastIds: string[] = [];
    const countingDb: SignerNamesDb = {
      bonusSignatureChain: { findUnique: async ({ where }) => ROWS[where.site_id] ?? null },
      user: {
        findMany: async ({ where }) => {
          calls += 1;
          lastIds = where.id.in;
          return where.id.in.map((id) => ({ id, name: USER_NAMES[id] ?? null }));
        },
      },
    };
    clearSignatureChainCache(countingDb);
    await resolveSlotSignerNames(WOODLAND, countingDb);
    expect(calls).toBe(1);
    expect([...lastIds].sort()).toEqual(['janette', 'morena']);
  });
});
