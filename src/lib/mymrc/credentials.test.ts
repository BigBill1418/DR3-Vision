import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { CredentialsNotConfiguredError, adminAuthStatePath, loadAdminCredentials } from './credentials';
import { setMymrcCredentials } from './credential-store';

// Tests for `src/lib/mymrc/credentials.ts` — the DB-backed admin credential
// reader (ADR-0057 D1/D9). The former per-site env-var scheme
// (MYMRC_{EUGENE,WOODLAND,OR,CA}_*) is DELETED: it was never honored. The
// load-bearing contract is now the OPPOSITE of the old fail-soft one — a missing
// credential must FAIL LOUD (throw), not return null/skip. That throw is what
// closes the historical silent-no-op failure mode (ADR-0057 D9).

const CRED_KEY = 'MYMRC_CRED_KEY';
const PATH_KEYS = ['MYMRC_AUTH_STATE_DIR', 'HOME', CRED_KEY] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PATH_KEYS) {
    ORIGINAL_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PATH_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

interface StoredRow {
  id: string;
  username: string;
  password_ciphertext: string;
  password_iv: string;
  password_auth_tag: string;
  key_version: number;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

// In-memory single-row fake (same shape as credential-store.test.ts) so we
// round-trip through the REAL crypto without a database.
function makeFakePrisma(): PrismaClient {
  let row: StoredRow | null = null;
  const client = {
    mymrcAdminCredential: {
      findUnique: async (): Promise<StoredRow | null> => (row ? { ...row } : null),
      upsert: async (args: { create: StoredRow; update: Partial<StoredRow> }): Promise<StoredRow> => {
        const now = new Date();
        row = row
          ? { ...row, ...args.update, updated_at: now }
          : { ...args.create, created_at: now, updated_at: now };
        return { ...row };
      },
    },
    auditLog: { create: async (): Promise<{ id: string }> => ({ id: 'audit-1' }) },
  };
  return client as unknown as PrismaClient;
}

describe('loadAdminCredentials — D9 fail-loud', () => {
  it('throws CredentialsNotConfiguredError when the store is empty', async () => {
    await expect(loadAdminCredentials(makeFakePrisma())).rejects.toBeInstanceOf(
      CredentialsNotConfiguredError,
    );
  });

  it('points the operator at /admin/mrc-scrape rather than resolving null', async () => {
    await expect(loadAdminCredentials(makeFakePrisma())).rejects.toThrow(/\/admin\/mrc-scrape/);
  });
});

describe('loadAdminCredentials — configured', () => {
  it('returns the decrypted admin credential once one is stored', async () => {
    process.env[CRED_KEY] = 'unit-test-cred-key';
    const prisma = makeFakePrisma();
    await setMymrcCredentials(
      prisma,
      { username: 'bill@svdp.us', password: 'sup3r-secret pass' },
      'user-1',
    );
    await expect(loadAdminCredentials(prisma)).resolves.toEqual({
      username: 'bill@svdp.us',
      password: 'sup3r-secret pass',
    });
  });

  it('propagates a decrypt failure (fail-closed), not "unconfigured"', async () => {
    process.env[CRED_KEY] = 'unit-test-cred-key';
    const prisma = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'bill@svdp.us', password: 'pw' }, 'user-1');
    // Wrong key on read: the store must throw (not return null), so the caller
    // fails loud instead of silently treating corruption as "not configured".
    process.env[CRED_KEY] = 'a-different-key';
    await expect(loadAdminCredentials(prisma)).rejects.not.toBeInstanceOf(
      CredentialsNotConfiguredError,
    );
  });
});

describe('adminAuthStatePath — single admin context (ADR-0057 D1)', () => {
  it('uses MYMRC_AUTH_STATE_DIR override when set', () => {
    process.env['MYMRC_AUTH_STATE_DIR'] = '/var/lib/mymrc';
    expect(adminAuthStatePath()).toBe('/var/lib/mymrc/mymrc-admin/auth.json');
  });

  it('falls back to ~/.dr3-vision/mymrc-admin/auth.json', () => {
    process.env['HOME'] = '/home/test';
    expect(adminAuthStatePath()).toBe('/home/test/.dr3-vision/mymrc-admin/auth.json');
  });
});
