// ADR-0067 Amendment A §A.7 — token-at-rest crypto.
//
// The property under test is FAIL-CLOSED. Every negative case must produce a
// thrown, named error — never a null, never a partial plaintext, never a
// degraded "not configured". A silent no-op on a credential path is the exact
// failure class ADR-0057 D9 was written to eliminate, and this suite is what
// stops it being reintroduced here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_KEY_VERSION,
  DocIngestDecryptError,
  DocIngestKeyUnavailableError,
  isKeyConfigured,
  open,
  openFromString,
  seal,
  sealToString,
} from '../secret-box';

const KEY_ENV = 'DOC_INGEST_TOKEN_KEY';
const ORIGINAL = process.env[KEY_ENV];

beforeEach(() => {
  process.env[KEY_ENV] = 'unit-test-doc-ingest-key-please-ignore';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = ORIGINAL;
});

/** Flip the first byte of a base64 payload — valid base64, altered content. */
function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = buf[0]! ^ 0xff;
  return buf.toString('base64');
}

describe('seal / open', () => {
  it('round-trips a refresh token', () => {
    const token = '0.AVoAqD6EcgvlAEWg1dkk6azLRSQkqS...refresh';
    expect(open(seal(token))).toBe(token);
  });

  it('produces a different ciphertext each time (random nonce)', () => {
    const a = seal('same-token');
    const b = seal('same-token');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    // ...and both still decrypt. A nonce reuse bug would pass the first
    // assertion and fail here.
    expect(open(a)).toBe('same-token');
    expect(open(b)).toBe('same-token');
  });

  it('FAILS CLOSED on tampered ciphertext rather than returning garbage', () => {
    const sealed = seal('a-token');
    expect(() => open({ ...sealed, ciphertext: flipFirstByte(sealed.ciphertext) })).toThrow(
      DocIngestDecryptError,
    );
  });

  it('FAILS CLOSED on a tampered auth tag', () => {
    const sealed = seal('a-token');
    expect(() => open({ ...sealed, authTag: flipFirstByte(sealed.authTag) })).toThrow(
      DocIngestDecryptError,
    );
  });

  it('FAILS CLOSED under a different key — never silently "not configured"', () => {
    const sealed = seal('a-token');
    process.env[KEY_ENV] = 'a-completely-different-key';
    expect(() => open(sealed)).toThrow(DocIngestDecryptError);
  });

  it('refuses an undecryptable key_version instead of guessing', () => {
    const sealed = seal('a-token');
    expect(() => open(sealed, CURRENT_KEY_VERSION + 1)).toThrow(DocIngestDecryptError);
  });

  it('throws LOUDLY when the key is missing — the §A.7 fail-loud requirement', () => {
    delete process.env[KEY_ENV];
    expect(() => seal('x')).toThrow(DocIngestKeyUnavailableError);
    expect(() => open({ ciphertext: 'AA==', iv: 'AA==', authTag: 'AA==' })).toThrow(
      DocIngestKeyUnavailableError,
    );
  });

  it('reports key presence without throwing (status path only)', () => {
    expect(isKeyConfigured()).toBe(true);
    delete process.env[KEY_ENV];
    expect(isKeyConfigured()).toBe(false);
  });

  it('treats a whitespace-only key as absent', () => {
    process.env[KEY_ENV] = '   ';
    expect(isKeyConfigured()).toBe(false);
    expect(() => seal('x')).toThrow(DocIngestKeyUnavailableError);
  });
});

describe('sealToString / openFromString (the OAuth handshake cookie)', () => {
  it('round-trips a structured envelope', () => {
    const envelope = { state: 'abc', codeVerifier: 'xyz', actorUserId: 'u1', issuedAt: 42 };
    expect(openFromString(sealToString(envelope))).toEqual(envelope);
  });

  it('rejects a forged cookie value', () => {
    expect(() => openFromString('not-a-sealed-value')).toThrow(DocIngestDecryptError);
  });

  it('rejects a structurally valid but tampered cookie', () => {
    const token = sealToString({ state: 'abc' });
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    const forged = Buffer.from(
      `${parts[0]}.${parts[1]}.${flipFirstByte(parts[2]!)}`,
      'utf8',
    ).toString('base64url');
    expect(() => openFromString(forged)).toThrow(DocIngestDecryptError);
  });

  it('rejects a cookie with too few segments', () => {
    const forged = Buffer.from('only.two', 'utf8').toString('base64url');
    expect(() => openFromString(forged)).toThrow(DocIngestDecryptError);
  });

  it('rethrows the LOUD key error rather than masking it as a bad cookie', () => {
    const token = sealToString({ state: 'abc' });
    delete process.env[KEY_ENV];
    expect(() => openFromString(token)).toThrow(DocIngestKeyUnavailableError);
  });
});
