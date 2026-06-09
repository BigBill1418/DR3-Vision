import { describe, it, expect } from 'vitest';
import { __testing, scrubUserForAudit } from './admin-users';

const { serializeForAudit } = __testing;

// Unit tests for the audit scrubber. These guard against the worst
// audit-log failure mode: PII leaking into a row that is, by hard
// rule #6, never deleted or updated. If `pin_hash` ever lands in
// the after-snapshot, that secret hash is in the database FOREVER.

describe('scrubUserForAudit', () => {
  const baseUser = {
    id: 'user-1',
    email: 'op@example.com',
    name: 'Op One',
    role: 'operator' as const,
    locale: 'en' as const,
    primary_site_id: 'site-eu',
    processor_role: null,
    is_active: true,
    all_sites: false,
    pin_hash: '$argon2id$v=19$m=19456,t=2,p=1$abc$xyz',
    deleted_at: null,
  };

  it('removes pin_hash from the output', () => {
    const out = scrubUserForAudit(baseUser);
    expect('pin_hash' in out).toBe(false);
    expect(JSON.stringify(out).includes('argon2id')).toBe(false);
  });

  it('records pin_set=true when a pin hash exists', () => {
    const out = scrubUserForAudit(baseUser);
    expect(out.pin_set).toBe(true);
  });

  it('records pin_set=false when no pin hash', () => {
    const out = scrubUserForAudit({ ...baseUser, pin_hash: null });
    expect(out.pin_set).toBe(false);
  });

  it('preserves non-secret fields verbatim', () => {
    const out = scrubUserForAudit(baseUser);
    expect(out.id).toBe(baseUser.id);
    expect(out.email).toBe(baseUser.email);
    expect(out.name).toBe(baseUser.name);
    expect(out.role).toBe(baseUser.role);
    expect(out.primary_site_id).toBe(baseUser.primary_site_id);
    expect(out.is_active).toBe(baseUser.is_active);
  });
});

describe('serializeForAudit', () => {
  it('emits no pin_hash key in the JSON', () => {
    const scrubbed = scrubUserForAudit({
      id: 'u',
      email: null,
      name: 'X',
      role: 'operator',
      locale: 'en',
      primary_site_id: 's',
      processor_role: null,
      is_active: true,
      all_sites: false,
      pin_hash: 'should-not-appear',
      deleted_at: null,
    });
    const json = JSON.stringify(serializeForAudit(scrubbed));
    expect(json).not.toContain('pin_hash');
    expect(json).not.toContain('should-not-appear');
  });

  it('refuses to serialize an object that still has pin_hash', () => {
    // Defensive: future refactor accidentally re-introduces pin_hash
    // and the audit row would carry it. The runtime probe must throw.
    const tainted = {
      id: 'u',
      pin_hash: '$argon2id$xxx',
      pin_set: true,
    } as unknown as ReturnType<typeof scrubUserForAudit>;
    expect(() => serializeForAudit(tainted)).toThrow(/pin_hash/);
  });

  it('refuses to serialize an object that still has password_hash', () => {
    // `password_hash` was dropped in the Sprint-2 cleanup migration,
    // but the runtime guard stays in place: if a future refactor
    // re-introduces a password-shaped column, the probe must catch
    // it before the hash reaches the append-only audit log.
    const tainted = {
      id: 'u',
      password_hash: '$argon2id$xxx',
      pin_set: false,
    } as unknown as ReturnType<typeof scrubUserForAudit>;
    expect(() => serializeForAudit(tainted)).toThrow(/password_hash/);
  });
});
