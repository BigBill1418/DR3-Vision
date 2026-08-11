// ADR-0019.5 — repo-wide guard against the header-encoding drop class.
//
// The class: HTTP header values are ByteStrings (latin-1). Node's undici throws
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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { toHeaderSafe } from '@/lib/ntfy-header-safe';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

  it('no publisher hardcodes a non-latin-1 character in a title template', () => {
    // Belt and braces: even with the sanitizer, a hardcoded em dash in a title
    // is a smell — it means someone wrote a title without knowing the
    // constraint, and the next publisher may not sanitize.
    const offenders: string[] = [];
    for (const p of publisherFiles()) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/title/i.test(line) || line.trimStart().startsWith('//')) return;
          if ([...line].some((c) => c.codePointAt(0)! > 255)) {
            offenders.push(`${p.replace(ROOT, '')}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('toHeaderSafe — the contract every publisher depends on', () => {
  it('makes any string latin-1 clean', () => {
    const nasty = 'em—dash arrow→ quotes“”‘’ ellipsis… emoji😀 ge≥ le≤ times×';
    for (const ch of toHeaderSafe(nasty)) {
      expect(ch.codePointAt(0)!).toBeLessThanOrEqual(255);
    }
  });

  it('is idempotent — sanitizing twice equals sanitizing once', () => {
    const s = 'STRANDED — DR3 Eugene → Period 16 … done';
    expect(toHeaderSafe(toHeaderSafe(s))).toBe(toHeaderSafe(s));
  });

  it('leaves plain ASCII untouched', () => {
    const s = 'URGENT: payroll deadline MISSED - Woodland Period 13';
    expect(toHeaderSafe(s)).toBe(s);
  });

  it('strips CR/LF — header injection defence, not just encoding', () => {
    expect(toHeaderSafe('a\r\nX-Evil: 1')).toBe('a  X-Evil: 1');
  });

  it('preserves latin-1 accents rather than mangling names', () => {
    // é is U+00E9 = 233, inside ByteString range. Sanitizing it would corrupt a
    // vendor or person name for no reason.
    expect(toHeaderSafe('café')).toBe('café');
  });
});

describe('the TS and .mjs sanitizers must not drift', () => {
  // Two implementations exist only because the cron daemons are dependency-free
  // plain JS. Four independent copies of this same fix across the fleet is
  // exactly how it survived three previous repairs, so the copies are pinned
  // equal here on the behaviour that matters.
  it('agree on every case the fleet has actually been bitten by', async () => {
    const mjs = (await import('../../scripts/ntfy-header-safe.mjs')) as {
      toHeaderSafe: (s: string) => string;
    };
    const cases = [
      'URGENT: bonus period STRANDED — DR3 Eugene Period 16',
      'Host saturation: droneops-server mem=78.7% load5=13.45 — cordoning',
      'period 2026-07-21→08-03',
      'quota ≥ 90% ≤ 100% × 2',
      'curly “quotes” and ‘apostrophes’ and ellipsis…',
      'emoji 😀 and café',
      'plain ascii, untouched',
      'a\r\nX-Evil: 1',
    ];
    for (const c of cases) {
      expect(mjs.toHeaderSafe(c), `mismatch for: ${c}`).toBe(toHeaderSafe(c));
    }
  });
});
