// ADR-0034 — token generation + shape validation tests (§14.2).

import { describe, it, expect } from 'vitest';
import { generateToken, isValidTokenShape } from '../tokens';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

describe('survey tokens', () => {
  it('20. generateToken returns a 32-char base64url string', () => {
    const t = generateToken();
    expect(t).toMatch(TOKEN_RE);
    expect(t.length).toBe(32);
  });

  it('21. two consecutive generateToken calls return distinct values (collision-safe)', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it('22. isValidTokenShape accepts 32-char base64url tokens, rejects everything else', () => {
    expect(isValidTokenShape(generateToken())).toBe(true);
    expect(isValidTokenShape('AbCd_-90AbCd_-90AbCd_-90AbCd_-90')).toBe(true); // 32 valid chars

    expect(isValidTokenShape('')).toBe(false);
    expect(isValidTokenShape('short')).toBe(false);
    expect(isValidTokenShape('a'.repeat(31))).toBe(false); // too short
    expect(isValidTokenShape('a'.repeat(33))).toBe(false); // too long
    expect(isValidTokenShape('a'.repeat(31) + '+')).toBe(false); // '+' not base64url
    expect(isValidTokenShape('a'.repeat(31) + '/')).toBe(false); // '/' not base64url
    expect(isValidTokenShape('a'.repeat(31) + '=')).toBe(false); // padding rejected
    expect(isValidTokenShape(null)).toBe(false);
    expect(isValidTokenShape(undefined)).toBe(false);
    expect(isValidTokenShape(12345)).toBe(false);
    expect(isValidTokenShape({})).toBe(false);
  });
});
