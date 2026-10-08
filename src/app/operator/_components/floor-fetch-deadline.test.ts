// ADR-0140 Amendment 1 — no awaited request on an operator screen may lack a deadline.
//
// PR #294 wrapped the offline-queue drain and the keypad, but an independent review
// found eleven bare `await fetch(` calls left in the floor screens themselves
// (count, void, drop-off, inbound, load photo), and two more were found in
// processed and queue conflicts while closing it — thirteen in all. Every
// one of them could leave a button disabled forever on the Woodland access point
// that reports "online" while the server is unreachable. They now go through
// `fetchWithTimeout`; this scan keeps a new one from arriving unnoticed.
//
// The only bare `fetch(` allowed is a fire-and-forget telemetry beacon written as
// `void fetch(` — nothing awaits it, so it cannot hold a busy flag.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const OPERATOR_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('operator screens — every awaited request has a deadline', () => {
  it('has no bare fetch( other than a `void fetch(` beacon', () => {
    const offenders: string[] = [];
    for (const file of sources(OPERATOR_DIR)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*\/\//.test(line)) return;
          if (!/(^|[^\w.])fetch\(/.test(line)) return;
          if (/\bvoid fetch\(/.test(line)) return;
          offenders.push(`${relative(OPERATOR_DIR, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, 'route these through fetchWithTimeout (ADR-0140)').toEqual([]);
  });

  it('the scan is not vacuous — it sees the screens it guards', () => {
    const files = sources(OPERATOR_DIR).map((f) => relative(OPERATOR_DIR, f));
    expect(files).toContain('[site]/count/count-client.tsx');
    expect(files).toContain('[site]/load/[id]/photo-input.tsx');
    const wrapped = sources(OPERATOR_DIR).filter((f) =>
      readFileSync(f, 'utf8').includes('fetchWithTimeout('),
    );
    expect(wrapped.length).toBeGreaterThanOrEqual(7);
  });
});
