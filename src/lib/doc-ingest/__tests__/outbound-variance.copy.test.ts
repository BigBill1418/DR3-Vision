// ADR-0108 — the coverage page states a distance, never a judgement.
//
// AK-4c is Bill's decision with Rick and Janette, and it has had no owner since
// 2026-08-08. The way a decision like that gets made by accident is not a
// meeting: it is one word in one caption. The first person to write "mismatch"
// next to a flagged load has answered the question — and every reader afterwards
// inherits the answer as though somebody chose it.
//
// So the banned vocabulary is asserted, not merely intended. This test reads the
// shipped source of the surfaces and fails on any of it.
//
// ── Why a source scan and not a render ─────────────────────────────────────
// The thing being guarded IS the literal text in the file. A render test would
// prove the words are absent from one code path on one fixture; the scan proves
// they are absent from every branch, including the ones no fixture reaches.
//
// ── Comments are excluded, and that is not a loophole ──────────────────────
// The ban is on what the OPERATOR reads, not on what the file may reason about.
// Both surfaces have to be able to say "this screen does not render a verdict,
// and here is the vocabulary it refuses" — and a guard that punishes its own
// disclaimer teaches the next author to delete the disclaimer, which is the
// opposite of the outcome. So full-line comments are stripped and everything
// else is scanned.
//
// The stripper deliberately only removes lines whose FIRST non-whitespace is
// `//`, plus whole `/* */` blocks. A general "strip from // to end of line"
// would eat the tail of any line containing `https://` — and a verdict word
// sitting after one would then pass unseen, which is precisely the class of
// silent-hole this file exists to close.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COVERAGE_PAGE = join(process.cwd(), 'src/app/admin/doc-ingest/outbound-coverage/page.tsx');
const SETTINGS_PAGE = join(process.cwd(), 'src/app/admin/doc-ingest/outbound-variance/page.tsx');

/**
 * The vocabulary of blame.
 *
 * `verdict` is deliberately NOT on this list: the page uses it to say it is not
 * rendering one ("This screen states no verdict"), and a guard that punishes its
 * own disclaimer trains the next author to delete the disclaimer. Same reason
 * `pass/fail` survives — it appears only in the sentence denying it.
 */
const VERDICT_WORDS = ['mismatch', 'discrepanc', 'dispute', 'error', 'incorrect', 'invalid'];

/** Drop full-line `//` comments and whole `/* *​/` blocks. Nothing else. */
export function strippedOfComments(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function scan(path: string): { source: string; rendered: string; hits: string[] } {
  const source = readFileSync(path, 'utf8');
  const rendered = strippedOfComments(source);
  const lower = rendered.toLowerCase();
  return { source, rendered, hits: VERDICT_WORDS.filter((w) => lower.includes(w)) };
}

describe('the flag copy accuses nobody of anything', () => {
  it('the coverage page contains none of the verdict words', () => {
    const { hits } = scan(COVERAGE_PAGE);
    expect(
      hits,
      `The coverage page must not grade the join. Found: ${hits.join(', ')}. ` +
        `A flag is a look-at-this; whether a difference is a problem, and at what ` +
        `size, is AK-4c and belongs to Bill with Rick and Janette (P-48).`,
    ).toEqual([]);
  });

  it('the settings page contains none of the verdict words', () => {
    const { hits } = scan(SETTINGS_PAGE);
    expect(hits, `Found: ${hits.join(', ')}`).toEqual([]);
  });

  it('proves it can fail — a verdict word in RENDERED copy survives the stripper', () => {
    // Without this, a broken stripper would delete everything and the two
    // assertions above would be vacuously green forever — the exact shape of
    // failure this repo has shipped before (a guard reporting green on nothing).
    const planted = [
      '// a comment may say mismatch, because it is explaining the ban',
      '        <p>The recorded weight is a mismatch against the expected figure.</p>',
    ].join('\n');
    const lower = strippedOfComments(planted).toLowerCase();

    expect(VERDICT_WORDS.filter((w) => lower.includes(w))).toEqual(['mismatch']);
    // And the comment really was dropped rather than the whole input surviving.
    expect(lower).not.toContain('explaining the ban');
  });

  it('proves the stripper keeps a line carrying a URL intact', () => {
    // A naive "strip from // to end of line" would eat the tail of this line,
    // and a verdict word after a URL would then pass unseen.
    const line = '        <a href="https://dr3-vision.svdp.us">mismatch</a>';
    expect(strippedOfComments(line).toLowerCase()).toContain('mismatch');
  });

  it('states the flag in the agreed non-committal wording', () => {
    const { rendered } = scan(COVERAGE_PAGE);
    // The phrase itself is the contract: it names a line, says the line is
    // movable, and stops.
    expect(rendered).toContain('exceeds the current variance threshold (editable)');
  });

  it('says out loud that the uncovered loads are expected, not lost', () => {
    const { rendered } = scan(COVERAGE_PAGE);
    // P-47. The uncovered count is ~3,850 and will stay that way until a
    // document covering those periods exists. A reader who takes it for data
    // loss will go looking for a bug that is not there.
    expect(rendered).toContain("expected — outside the workbook's range, not missing data");
  });

  it('opens no alert channel from either surface', () => {
    // AK-4c boundary: flags are looked at, never delivered. If this ever needs
    // to change it is a decision, and the decision will have to delete a test.
    for (const path of [COVERAGE_PAGE, SETTINGS_PAGE]) {
      const { source } = scan(path);
      for (const channel of ['ntfy', 'sendMail', 'sendEmail', 'notify', 'publishAlert']) {
        expect(source, `${path} must not reach ${channel}`).not.toContain(channel);
      }
    }
  });
});
