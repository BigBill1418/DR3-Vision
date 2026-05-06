import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authStatePath, loadSiteCredentials } from './credentials';

// Tests for `src/lib/mymrc/credentials.ts`. The `loadSiteCredentials`
// fail-soft contract is load-bearing: when env vars aren't set, the
// caller (cron wrapper) MUST log + skip without publishing to ntfy.
// Returning anything other than `null` for the unconfigured case would
// trigger an alert storm on every fresh deploy.

const ALL_KEYS = [
  'MYMRC_EUGENE_USERNAME',
  'MYMRC_EUGENE_PASSWORD',
  'MYMRC_OR_USERNAME',
  'MYMRC_OR_PASSWORD',
  'MYMRC_WOODLAND_USERNAME',
  'MYMRC_WOODLAND_PASSWORD',
  'MYMRC_CA_USERNAME',
  'MYMRC_CA_PASSWORD',
  'MYMRC_AUTH_STATE_DIR',
  'HOME',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ALL_KEYS) {
    ORIGINAL_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ALL_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

describe('loadSiteCredentials — fail-soft', () => {
  it('returns null for both sites when no env vars set', () => {
    expect(loadSiteCredentials('eugene')).toBeNull();
    expect(loadSiteCredentials('woodland')).toBeNull();
  });

  it('returns null when only the username half of a pair is set', () => {
    process.env['MYMRC_EUGENE_USERNAME'] = 'user@svdp.us';
    expect(loadSiteCredentials('eugene')).toBeNull();
  });

  it('returns null when only the password half of a pair is set', () => {
    process.env['MYMRC_WOODLAND_PASSWORD'] = 'shhh';
    expect(loadSiteCredentials('woodland')).toBeNull();
  });

  it('treats whitespace-only values as unset', () => {
    process.env['MYMRC_EUGENE_USERNAME'] = '   ';
    process.env['MYMRC_EUGENE_PASSWORD'] = '   ';
    expect(loadSiteCredentials('eugene')).toBeNull();
  });
});

describe('loadSiteCredentials — site-name form (preferred)', () => {
  it('reads MYMRC_EUGENE_* for eugene', () => {
    process.env['MYMRC_EUGENE_USERNAME'] = 'eu@svdp.us';
    process.env['MYMRC_EUGENE_PASSWORD'] = 'pw-eu';
    expect(loadSiteCredentials('eugene')).toEqual({
      site: 'eugene',
      username: 'eu@svdp.us',
      password: 'pw-eu',
    });
  });

  it('reads MYMRC_WOODLAND_* for woodland', () => {
    process.env['MYMRC_WOODLAND_USERNAME'] = 'wo@svdp.us';
    process.env['MYMRC_WOODLAND_PASSWORD'] = 'pw-wo';
    expect(loadSiteCredentials('woodland')).toEqual({
      site: 'woodland',
      username: 'wo@svdp.us',
      password: 'pw-wo',
    });
  });
});

describe('loadSiteCredentials — jurisdiction form (legacy alias)', () => {
  it('reads MYMRC_OR_* for eugene when site-name form is absent', () => {
    process.env['MYMRC_OR_USERNAME'] = 'or@svdp.us';
    process.env['MYMRC_OR_PASSWORD'] = 'pw-or';
    expect(loadSiteCredentials('eugene')).toEqual({
      site: 'eugene',
      username: 'or@svdp.us',
      password: 'pw-or',
    });
  });

  it('reads MYMRC_CA_* for woodland when site-name form is absent', () => {
    process.env['MYMRC_CA_USERNAME'] = 'ca@svdp.us';
    process.env['MYMRC_CA_PASSWORD'] = 'pw-ca';
    expect(loadSiteCredentials('woodland')).toEqual({
      site: 'woodland',
      username: 'ca@svdp.us',
      password: 'pw-ca',
    });
  });

  it('site-name form wins when both forms are set for the same site', () => {
    process.env['MYMRC_EUGENE_USERNAME'] = 'preferred@svdp.us';
    process.env['MYMRC_EUGENE_PASSWORD'] = 'preferred-pw';
    process.env['MYMRC_OR_USERNAME'] = 'legacy@svdp.us';
    process.env['MYMRC_OR_PASSWORD'] = 'legacy-pw';
    const creds = loadSiteCredentials('eugene');
    expect(creds?.username).toBe('preferred@svdp.us');
    expect(creds?.password).toBe('preferred-pw');
  });
});

describe('authStatePath', () => {
  it('uses MYMRC_AUTH_STATE_DIR override when set', () => {
    process.env['MYMRC_AUTH_STATE_DIR'] = '/var/lib/mymrc';
    expect(authStatePath('eugene')).toBe('/var/lib/mymrc/mymrc-eugene/auth.json');
    expect(authStatePath('woodland')).toBe('/var/lib/mymrc/mymrc-woodland/auth.json');
  });

  it('falls back to ~/.dr3-vision/mymrc-{site}/auth.json', () => {
    process.env['HOME'] = '/home/test';
    expect(authStatePath('eugene')).toBe('/home/test/.dr3-vision/mymrc-eugene/auth.json');
  });
});
