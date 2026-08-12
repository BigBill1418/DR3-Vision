// ADR-0019.5 / ADR-0093 — repo-wide guard against the header-encoding drop class.
//
// The class: HTTP header values are ByteStrings. Node's undici throws
// `Cannot convert argument to a ByteString because the character at index N has
// a value of 8212 which is greater than 255` for any codepoint > 255. An em dash
// in `X-Title` therefore kills the publish BEFORE a socket opens — identically
// on the primary and the fallback — so the page is lost while the ntfy server is
// demonstrably healthy. That is how Eugene's stranded-period page vanished on
// 2026-08-05.
//
// This has now been fixed four times on the fleet (bash/Python 2026-05-06,
// noc-master's Node publisher ADR-0063 2026-05-22, and both of this repo's
// publishers on 2026-08-11). Every previous fix was per-publisher, so the next
// publisher re-introduced it. This test is the structural answer: it enumerates
// every module that builds ntfy headers and asserts each routes through the one
// shared sanitizer. A fifth publisher fails this test on the day it is written.
//
// CONTRACT v2 (ADR-0093): the output must be PURE ASCII, not merely latin-1,
// because httpx — used by other fleet publishers — raises above U+007F where
// undici tolerates up to U+00FF. The behaviour is pinned against the SHARED
// fleet vectors vendored at `./ntfy-header-conformance.json` (canonical copy:
// `noc-master/data/ntfy-header-conformance.json`).
//
// Vendored rather than fetched at runtime, on purpose: a network fetch that
// fails degrades to a SKIPPED test — a safety net that lies, which is the whole
// pattern being eliminated here.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { toHeaderSafe } from '@/lib/ntfy-header-safe';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Vector {
  id: string;
  input: string;
  expected: string;
  why: string;
}

const VECTORS_PATH = fileURLToPath(new URL('./ntfy-header-conformance.json', import.meta.url));

function loadVectors(): Vector[] {
  return JSON.parse(readFileSync(VECTORS_PATH, 'utf8')).vectors as Vector[];
}

const VECTORS = loadVectors();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(name) && !/\.test\.|\.d\./.test(name)) out.push(p);
  }
  return out;
}

/** Every non-test source file that sets an ntfy title header. */
function publisherFiles(): string[] {
  return walk(join(ROOT, 'src'))
    .concat(walk(join(ROOT, 'scripts')))
    .filter((p) => /['"]X-Title['"]/.test(readFileSync(p, 'utf8')));
}

describe('ntfy header safety — repo-wide sweep (ADR-0019.5)', () => {
  it('finds the publishers (guard against the sweep silently matching nothing)', () => {
    // An empty sweep would pass every assertion below while checking nothing —
    // the empty-set trap. Pin a floor.
    expect(publisherFiles().length).toBeGreaterThanOrEqual(2);
  });

  it('every module that sets X-Title sanitizes its headers', () => {
    const offenders = publisherFiles().filter((p) => {
      const src = readFileSync(p, 'utf8');
      return !/toHeaderSafe|_ascii_header|asciiHeader/.test(src);
    });
    expect(
      offenders.map((p) => p.replace(ROOT, '')),
      'these build ntfy headers without routing them through toHeaderSafe — a raw ' +
        'em dash in any of their titles is a silently dropped page on BOTH transports',
    ).toEqual([]);
  });

  it('no publisher hardcodes a non-ASCII character in a title template', () => {
    // Belt and braces: even with the sanitizer, a hardcoded em dash in a title
    // is a smell — it means someone wrote a title without knowing the
    // constraint, and the next publisher may not sanitize. Threshold is 127,
    // not 255: under contract v2 a latin-1 accent is just as unsendable as an
    // em dash to an httpx-based publisher.
    const offenders: string[] = [];
    for (const p of publisherFiles()) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/title/i.test(line) || line.trimStart().startsWith('//')) return;
          if ([...line].some((c) => c.codePointAt(0)! > 127)) {
            offenders.push(`${p.replace(ROOT, '')}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('toHeaderSafe — conformance to the shared fleet vectors (ADR-0093)', () => {
  it('the vendored vector file is present and not hollowed out', () => {
    // An empty or truncated vector file would make every per-vector assertion
    // below pass while checking nothing. Pin a floor.
    expect(VECTORS.length).toBeGreaterThanOrEqual(15);
  });

  it.each(VECTORS.map((v) => [v.id, v] as const))('vector %s', (_id, v) => {
    expect(toHeaderSafe(v.input), v.why).toBe(v.expected);
  });

  it.each(VECTORS.map((v) => [v.id, v] as const))('vector %s is pure ASCII', (_id, v) => {
    // The actual contract httpx enforces. Asserted independently of the
    // `expected` strings, so a wrong vector cannot make a broken implementation
    // look correct.
    for (const ch of toHeaderSafe(v.input)) {
      expect(
        ch.codePointAt(0)!,
        `${JSON.stringify(ch)} would raise UnicodeEncodeError in httpx`,
      ).toBeLessThan(128);
    }
  });

  it.each(VECTORS.map((v) => [v.id, v] as const))(
    'vector %s is accepted by the real HTTP client',
    (_id, v) => {
      // The end-to-end assertion: build a REAL undici Request — the exact
      // operation that threw in production. No network; the ByteString
      // conversion happens at construction.
      expect(
        () =>
          new Request('https://ntfy.invalid/topic', {
            method: 'POST',
            headers: { 'X-Title': toHeaderSafe(v.input) },
            body: 'x',
          }),
      ).not.toThrow();
    },
  );

  it('is idempotent — sanitizing twice equals sanitizing once', () => {
    for (const v of VECTORS) {
      const once = toHeaderSafe(v.input);
      expect(toHeaderSafe(once), v.id).toBe(once);
    }
  });
});

describe('toHeaderSafe — the properties the contract exists for', () => {
  it('the RAW em-dash title genuinely still throws in undici', () => {
    // Prove the bug is real rather than trusting the ADR. If undici ever stops
    // throwing, this test fails and tells us the constraint changed — rather
    // than us carrying a sanitizer forever for a reason nobody can reproduce.
    expect(
      () =>
        new Request('https://ntfy.invalid/topic', {
          method: 'POST',
          headers: { 'X-Title': 'URGENT: bonus period STRANDED — DR3 Eugene Period 16' },
          body: 'x',
        }),
    ).toThrow(/ByteString/);
  });

  it('undici ACCEPTS latin-1, which is why the pure-ASCII assertion is the real guard', () => {
    // Honest scoping of the test above: undici's wall is U+00FF, so a Request
    // built here would happily carry `café` and a v1 (latin-1) regression would
    // sail past it. httpx is the binding constraint and cannot be exercised from
    // Node — so the pure-ASCII assertion, not this client, is what pins v2.
    expect(
      () =>
        new Request('https://ntfy.invalid/topic', {
          method: 'POST',
          headers: { 'X-Title': 'café' },
          body: 'x',
        }),
    ).not.toThrow();
  });

  it('folds accents to readable ASCII rather than question marks', () => {
    // An ASCII-only contract is only tolerable to a human reader because names
    // survive it. "caf?" would be a regression in readability, not a fix.
    expect(toHeaderSafe('café renewal for José')).toBe('cafe renewal for Jose');
    expect(toHeaderSafe('naïve ÿ')).not.toContain('?');
  });

  it('strips CR/LF — header injection defence, not just encoding', () => {
    // Each becomes a space rather than being deleted: dropping them would splice
    // two header fields into one token.
    expect(toHeaderSafe('ok\r\nX-Evil: 1')).toBe('ok  X-Evil: 1');
  });

  it('leaves plain ASCII untouched', () => {
    const s = 'URGENT: payroll deadline MISSED - Woodland Period 13';
    expect(toHeaderSafe(s)).toBe(s);
  });

  it('degrades an astral emoji to ONE question mark, not two', () => {
    // Iterating UTF-16 units instead of codepoints would emit '??' for one
    // glyph, because an astral character is a surrogate pair.
    expect(toHeaderSafe('x\u{1F600}y')).toBe('x?y');
  });
});

describe('the TS and .mjs sanitizers must not drift', () => {
  // Two implementations exist only because the cron daemons are dependency-free
  // plain JS. Four independent copies of this same fix across the fleet is
  // exactly how it survived three previous repairs, so the copies are pinned
  // equal here — against the SHARED vector set rather than an ad-hoc case list,
  // so the pin widens whenever the fleet contract does.
  it('the .mjs twin conforms to every fleet vector, independently', async () => {
    const mjs = (await import('../../scripts/ntfy-header-safe.mjs')) as {
      toHeaderSafe: (s: string) => string;
    };
    for (const v of VECTORS) {
      expect(mjs.toHeaderSafe(v.input), `${v.id}: ${v.why}`).toBe(v.expected);
    }
  });

  it('the two implementations agree character-for-character', async () => {
    const mjs = (await import('../../scripts/ntfy-header-safe.mjs')) as {
      toHeaderSafe: (s: string) => string;
    };
    const cases = [
      ...VECTORS.map((v) => v.input),
      // Beyond the vectors: classes the fleet table covers but no vector pins.
      'a · b',
      'a‑b',
      'a‒b',
      'a―b',
      'a‚b',
      'a„b',
      '21°C',
      'Straße',
      'x\u{1F600}y',
    ];
    for (const c of cases) {
      expect(mjs.toHeaderSafe(c), `mismatch for: ${JSON.stringify(c)}`).toBe(toHeaderSafe(c));
    }
  });
});
