import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  CredentialDecryptError,
  CredentialKeyUnavailableError,
  InvalidCredentialInputError,
  getMymrcCredentialStatus,
  getMymrcCredentials,
  setMymrcCredentials,
} from './credential-store';

// Tests for the encrypted MyMRC admin credential store (ADR-0057 D1/D9). The
// load-bearing guarantees: (1) round-trip fidelity, (2) the password is
// write-only — never in a status result, an audit row, or a log, (3) tampered
// ciphertext/tag fails CLOSED (never a garbage plaintext, never "unconfigured"),
// (4) empty/whitespace input is rejected, (5) missing key aborts loudly.

const CRED_KEY = 'MYMRC_CRED_KEY';
const ACTOR = 'user-admin-1';

// ── In-memory prisma fake (single-row table + audit sink) ────────────────────

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

function makeFakePrisma() {
  let row: StoredRow | null = null;
  const audits: Array<Record<string, unknown>> = [];
  const client = {
    mymrcAdminCredential: {
      findUnique: async (): Promise<StoredRow | null> => (row ? { ...row } : null),
      upsert: async (args: {
        create: StoredRow;
        update: Partial<StoredRow>;
      }): Promise<StoredRow> => {
        const now = new Date();
        row = row ? { ...row, ...args.update, updated_at: now } : { ...args.create, created_at: now, updated_at: now };
        return { ...row };
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }): Promise<{ id: string }> => {
        audits.push(args.data);
        return { id: `audit-${audits.length}` };
      },
    },
  };
  return {
    prisma: client as unknown as PrismaClient,
    audits,
    peek: (): StoredRow | null => row,
    mutate: (fn: (r: StoredRow) => void): void => {
      if (row) fn(row);
    },
  };
}

/** Re-encode base64 with its first byte flipped — a valid-but-altered payload. */
function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = buf[0]! ^ 0xff;
  return buf.toString('base64');
}

const ORIGINAL_KEY = process.env[CRED_KEY];

beforeEach(() => {
  process.env[CRED_KEY] = 'unit-test-encryption-secret-please-ignore';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env[CRED_KEY];
  else process.env[CRED_KEY] = ORIGINAL_KEY;
});

// ── Round-trip ───────────────────────────────────────────────────────────────

describe('setMymrcCredentials / getMymrcCredentials round-trip', () => {
  it('decrypts back to the exact username and password', async () => {
    const { prisma } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'bill@dr3.example', password: 'S3cr3t!  pw' }, ACTOR);
    const got = await getMymrcCredentials(prisma);
    expect(got).toEqual({ username: 'bill@dr3.example', password: 'S3cr3t!  pw' });
  });

  it('stores ciphertext, not the plaintext password', async () => {
    const { prisma, peek } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'plaintext-pw' }, ACTOR);
    const stored = peek();
    expect(stored?.password_ciphertext).toBeTruthy();
    expect(stored?.password_ciphertext).not.toContain('plaintext-pw');
    expect(JSON.stringify(stored)).not.toContain('plaintext-pw');
  });

  it('a second set rotates the value and re-decrypts to the new password', async () => {
    const { prisma } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'old-pw' }, ACTOR);
    await setMymrcCredentials(prisma, { username: 'u2', password: 'new-pw' }, 'user-admin-2');
    expect(await getMymrcCredentials(prisma)).toEqual({ username: 'u2', password: 'new-pw' });
  });

  it('returns null when no credentials are configured', async () => {
    const { prisma } = makeFakePrisma();
    expect(await getMymrcCredentials(prisma)).toBeNull();
  });
});

// ── Status never leaks the secret ────────────────────────────────────────────

describe('getMymrcCredentialStatus', () => {
  it('reports unconfigured with all-null fields when empty', async () => {
    const { prisma } = makeFakePrisma();
    expect(await getMymrcCredentialStatus(prisma)).toEqual({
      configured: false,
      username: null,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('exposes only non-secret metadata — never the password or ciphertext', async () => {
    const { prisma } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'bill@dr3.example', password: 'topsecretpw' }, ACTOR);
    const status = await getMymrcCredentialStatus(prisma);

    expect(status.configured).toBe(true);
    expect(status.username).toBe('bill@dr3.example');
    expect(status.updatedBy).toBe(ACTOR);
    expect(status.updatedAt).toBeInstanceOf(Date);
    // Exactly the four safe keys — no password, no ciphertext, no iv/tag.
    expect(Object.keys(status).sort()).toEqual(['configured', 'updatedAt', 'updatedBy', 'username']);
    expect(JSON.stringify(status)).not.toContain('topsecretpw');
  });
});

// ── Audit trail is password-free ─────────────────────────────────────────────

describe('setMymrcCredentials audit log', () => {
  it('writes an insert audit row on first config, update on subsequent', async () => {
    const { prisma, audits } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'pw1' }, ACTOR);
    await setMymrcCredentials(prisma, { username: 'u', password: 'pw2' }, ACTOR);
    expect(audits).toHaveLength(2);
    expect(audits[0]?.['action']).toBe('insert');
    expect(audits[1]?.['action']).toBe('update');
    expect(audits[0]?.['table_name']).toBe('mymrc_admin_credentials');
    expect(audits[0]?.['actor_user_id']).toBe(ACTOR);
  });

  it('never records the password or ciphertext in the audit row', async () => {
    const { prisma, audits } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'never-log-me' }, ACTOR);
    expect(JSON.stringify(audits)).not.toContain('never-log-me');
  });
});

// ── Fail-closed on tamper ────────────────────────────────────────────────────

describe('getMymrcCredentials fails closed on tamper', () => {
  it('throws CredentialDecryptError when the ciphertext is altered', async () => {
    const { prisma, mutate } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'pw' }, ACTOR);
    mutate((r) => {
      r.password_ciphertext = flipFirstByte(r.password_ciphertext);
    });
    await expect(getMymrcCredentials(prisma)).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('throws CredentialDecryptError when the GCM auth tag is altered', async () => {
    const { prisma, mutate } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'pw' }, ACTOR);
    mutate((r) => {
      r.password_auth_tag = flipFirstByte(r.password_auth_tag);
    });
    await expect(getMymrcCredentials(prisma)).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('throws (not null) when key_version is not decryptable by the current scheme', async () => {
    const { prisma, mutate } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'pw' }, ACTOR);
    mutate((r) => {
      r.key_version = 999;
    });
    await expect(getMymrcCredentials(prisma)).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('cannot decrypt with a different MYMRC_CRED_KEY', async () => {
    const { prisma } = makeFakePrisma();
    await setMymrcCredentials(prisma, { username: 'u', password: 'pw' }, ACTOR);
    process.env[CRED_KEY] = 'a-completely-different-secret';
    await expect(getMymrcCredentials(prisma)).rejects.toBeInstanceOf(CredentialDecryptError);
  });
});

// ── Input validation ─────────────────────────────────────────────────────────

describe('setMymrcCredentials input validation', () => {
  it.each([
    ['empty username', { username: '', password: 'pw' }],
    ['whitespace username', { username: '   ', password: 'pw' }],
    ['empty password', { username: 'u', password: '' }],
    ['whitespace password', { username: 'u', password: '\t \n' }],
  ])('rejects %s', async (_label, input) => {
    const { prisma, peek, audits } = makeFakePrisma();
    await expect(setMymrcCredentials(prisma, input, ACTOR)).rejects.toBeInstanceOf(
      InvalidCredentialInputError,
    );
    expect(peek()).toBeNull(); // nothing persisted
    expect(audits).toHaveLength(0); // nothing audited
  });

  it('rejects an empty actorUserId', async () => {
    const { prisma } = makeFakePrisma();
    await expect(
      setMymrcCredentials(prisma, { username: 'u', password: 'pw' }, '  '),
    ).rejects.toBeInstanceOf(InvalidCredentialInputError);
  });
});

// ── Missing key ──────────────────────────────────────────────────────────────

describe('MYMRC_CRED_KEY requirement', () => {
  it('setMymrcCredentials throws CredentialKeyUnavailableError when the key is unset', async () => {
    delete process.env[CRED_KEY];
    const { prisma, peek } = makeFakePrisma();
    await expect(
      setMymrcCredentials(prisma, { username: 'u', password: 'pw' }, ACTOR),
    ).rejects.toBeInstanceOf(CredentialKeyUnavailableError);
    expect(peek()).toBeNull(); // key checked before any write
  });
});

// ── Migration ↔ schema parity ────────────────────────────────────────────────

describe('migration / schema parity', () => {
  const root = process.cwd();
  const migrationSql = readFileSync(
    resolve(root, 'prisma/migrations/20260802_adr0057_mymrc_admin_credentials/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');

  const COLUMNS = [
    'id',
    'username',
    'password_ciphertext',
    'password_iv',
    'password_auth_tag',
    'key_version',
    'updated_by',
    'created_at',
    'updated_at',
  ];

  it('migration creates the mapped table with every column', () => {
    expect(migrationSql).toContain('CREATE TABLE "mymrc_admin_credentials"');
    for (const col of COLUMNS) {
      expect(migrationSql).toContain(`"${col}"`);
    }
  });

  it('migration enforces the singleton CHECK', () => {
    expect(migrationSql).toContain("CHECK (\"id\" = 'singleton')");
  });

  it('schema.prisma declares the model mapped to the same table', () => {
    expect(schema).toContain('model MymrcAdminCredential');
    expect(schema).toContain('@@map("mymrc_admin_credentials")');
  });
});
