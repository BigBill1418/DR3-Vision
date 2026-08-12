#!/usr/bin/env node
// ADR citation resolver (ADR-0098 C1; prescribed by ADR-0094 §5 P5).
//
// THE DEFECT THIS CATCHES. Five source files and one test carried the comment
// "ADR-0065 Amendment 2 — the Pacific day, not the UTC day." No such amendment
// existed. The work was real and shipped (7e1cf342, 2026-07-30) — six manager
// screens defaulted their date inputs to TOMORROW after 5 PM Pacific — but the
// record was never written, so for twelve days the code pointed at a section
// that did not exist and nothing said so.
//
// That is not a typo class. It is the ADR-0064 class: "This ADR was referenced
// by the code it governs … but the file itself was never committed." A citation
// is a promise that a reason is written down somewhere. When the citation does
// not resolve, the reason is gone and the next author cannot tell whether the
// constraint is real, superseded, or imagined.
//
// WHAT IT DOES. Every `ADR-NNNN` and `ADR-NNNN Amendment K` / `Am.K` reference
// in the scanned trees must resolve to a real file in `docs/adr/`, and — when an
// amendment is named — to a real `## Amendment K` heading inside that file.
//
// HARD GATE: this exits non-zero. It is cheap, deterministic, and reads only
// files already in the repo.
//
//   node scripts/check-adr-citations.mjs          # scan + report + exit code
//
// The companion vitest (`src/lib/adr-citations.test.ts`) runs the same functions
// in the normal suite, so the gate fires locally and in CI without a new job.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

/** Trees scanned for citations, relative to the repo root. */
export const DEFAULT_SCAN_DIRS = ['src', 'scripts', 'e2e', 'tests'];

/** Extensions treated as code. Markdown is deliberately excluded — see below. */
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git']);

/**
 * ADRs that live in ANOTHER fleet repo and are legitimately cited from here.
 *
 * This is an explicit allowlist rather than a numeric range on purpose: a range
 * silently accepts a typo'd number, which is the exact failure this script
 * exists to catch. Adding an entry is a deliberate, reviewable act.
 */
export const FLEET_ADRS = {
  // noc-master ADR-0200 — the fleet ntfy header-safety contract. DR3 implements
  // it (`scripts/ntfy-header-safe.mjs`) and conforms against its vectors, so the
  // citation is correct even though the record is not in this repo.
  '0200': 'noc-master/docs/adr/0200-fleet-ntfy-header-safety-conformance.md',
};

/**
 * PRE-EXISTING drift, discovered by ADR-0094 §3 RC-4 and baselined so this gate
 * could be turned on as a HARD failure the day it was written.
 *
 * Every entry is an amendment that CODE CITES and NOBODY EVER WROTE. They are
 * not typos — the work shipped, the record did not, exactly as ADR-0065 Am.2
 * documents for its own case. Writing five more amendments would mean inventing
 * history for work this author did not do and cannot verify, so they are tracked
 * here and in `docs/adr/PROMISES.md` instead of being silently tolerated.
 *
 * The baseline RATCHETS: an entry that no longer resolves to a violation FAILS
 * the check with "stale baseline entry", so the list can only shrink. That is
 * what keeps it from becoming the second `OPEN-ITEMS.md` — a place promises go
 * rather than a place they come back from (ADR-0094 §3 RC-4).
 *
 * To retire an entry: write the amendment (or correct the citations), then
 * delete the line. Both are one PR.
 */
export const KNOWN_UNRESOLVED = [
  { adr: '0068', amendment: 3, since: '2026-08-11', note: 'AP queue + reimbursements; 8 citations' },
  { adr: '0068', amendment: 4, since: '2026-08-11', note: 'admin reimbursements page; 2 citations' },
  { adr: '0068', amendment: 5, since: '2026-08-11', note: 'reimbursement notify + public paths; 4 citations' },
  { adr: '0069', amendment: 3, since: '2026-08-11', note: 'commodity-extract; 2 citations' },
  { adr: '0019.5', amendment: 1, since: '2026-08-11', note: 'doc-ingest anomaly tests; 2 citations' },
];

const baselineKey = (adr, amendment) => `${adr}#${amendment ?? ''}`;
const BASELINE_KEYS = new Set(KNOWN_UNRESOLVED.map((e) => baselineKey(e.adr, e.amendment)));

/**
 * Matches `ADR-0065`, `ADR-0019.5`, `ADR-0065 Amendment 2`, `ADR-0065 Am.2`.
 *
 * The amendment half is optional and tolerant of the spacing this repo actually
 * uses (`Am.1`, `Am. 1`, `Amendment 1`). It deliberately does NOT match `§` or
 * `D5` sub-references: those are far more varied in the wild and a false failure
 * on a decision-letter reference would train people to disable the gate.
 */
const CITATION_RE = /ADR-(\d{4}(?:\.\d+)?)(?:\s+(?:Amendment|Am\.?)\s*(\d+))?/g;

/**
 * This repo records amendments in TWO conventions, and an index that knows only
 * one of them reports the other as missing. Both are matched:
 *
 *   1. IN-FILE heading — `## Amendment 2 — …` inside the parent ADR
 *      (ADR-0046, 0065, 0067, 0068 …).
 *   2. SEPARATE FILE — `0069-amendment-2-terex-maintenance-absorption.md`, whose
 *      H1 reads `# ADR-0069 Amendment 2 — …` (ADR-0067 Am.8, ADR-0069 Am.1/2).
 *
 * Convention 2 is why this index MERGES amendments across every file sharing a
 * number instead of keying one file per number. Getting that wrong is not a
 * harmless bug: the first draft of this script keyed the last file read and
 * reported 46 false violations against ADR-0067 and ADR-0069 — a gate that cries
 * wolf gets switched off, so the false-positive cost here is higher than the
 * miss cost.
 */
const AMENDMENT_HEADING_RE = /^#{1,6}\s*(?:Amendment|Am\.?)\s*(\d+)\b/gim;

/** H1 of a separate amendment FILE: `# ADR-0069 Amendment 2 — …`. */
const AMENDMENT_FILE_H1_RE = /^#\s*ADR-\d{4}(?:\.\d+)?\s*(?:Amendment|Am\.?)\s*(\d+)\b/im;

/**
 * Filename of a separate amendment file: `0069-amendment-2-…`.
 *
 * Requires a DIGIT right after `amendment-`, which is what keeps
 * `0029-amendment-notification-batching.md` (an ADR *about* amendments, not an
 * amendment) from being read as one.
 */
const AMENDMENT_FILENAME_RE = /^(\d{4}(?:\.\d+)?)-amendment-(\d+)-/i;

/** Recursively collect code files under `dir`. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a scan dir that does not exist is not an error
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(extname(full))) out.push(full);
  }
  return out;
}

/**
 * Index every ADR in `adrDir` by its number, recording which numbered
 * amendments it declares as headings.
 */
export function collectAdrIndex(adrDir) {
  const index = new Map();
  let files;
  try {
    files = readdirSync(adrDir);
  } catch {
    return index;
  }
  for (const file of files) {
    const m = /^(\d{4}(?:\.\d+)?)[-.]/.exec(file);
    if (!m || extname(file) !== '.md') continue;
    const number = m[1];
    const text = readFileSync(join(adrDir, file), 'utf8');

    // MERGE, never replace: a number can be spread over a parent file plus one
    // file per separate amendment.
    let entry = index.get(number);
    if (!entry) {
      entry = { files: [], amendments: new Set() };
      index.set(number, entry);
    }
    entry.files.push(file);

    for (const hit of text.matchAll(AMENDMENT_HEADING_RE)) {
      entry.amendments.add(Number(hit[1]));
    }
    const h1 = AMENDMENT_FILE_H1_RE.exec(text);
    if (h1) entry.amendments.add(Number(h1[1]));
    const fn = AMENDMENT_FILENAME_RE.exec(file);
    if (fn) entry.amendments.add(Number(fn[2]));
  }
  return index;
}

/**
 * Two different ADRs claiming the SAME number.
 *
 * The index above merges every file sharing a number, which is correct for
 * amendments and blind to a collision — so on 2026-08-11 two unrelated ADRs both
 * landed on `main` as ADR-0097, nineteen seconds apart in PR creation, and this
 * checker reported everything green. A citation to "ADR-0097" then resolves to
 * two different decisions, which is worse than one that resolves to none: it
 * looks correct.
 *
 * A number legitimately spans several files ONLY when the extras are amendment
 * files (`0069-amendment-2-*.md`). Two or more PRIMARY files on one number is a
 * collision. The repo's rule is that the number belongs to the first PUSHED
 * reference; the later claim renumbers.
 */
export function findDuplicateAdrNumbers(adrDir) {
  const index = collectAdrIndex(adrDir);
  const collisions = [];
  for (const [number, entry] of index) {
    const primaries = entry.files.filter((f) => !AMENDMENT_FILENAME_RE.test(f));
    if (primaries.length > 1) collisions.push({ number, files: primaries.sort() });
  }
  return collisions;
}

/** Extract every ADR citation in `text`, with 1-based line numbers. */
export function extractCitations(text) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(CITATION_RE)) {
      found.push({
        adr: m[1],
        amendment: m[2] ? Number(m[2]) : null,
        line: i + 1,
        text: line.trim(),
      });
    }
  }
  return found;
}

/**
 * Resolve every citation in the scanned trees against the ADR index.
 *
 * Returns `{ violations, stats }`. A violation is `{ file, line, adr,
 * amendment, kind, message }` where `kind` is `missing-adr` or
 * `missing-amendment`.
 */
export function checkAdrCitations({
  repoRoot = process.cwd(),
  scanDirs = DEFAULT_SCAN_DIRS,
  adrDir = join(repoRoot, 'docs', 'adr'),
} = {}) {
  const index = collectAdrIndex(adrDir);
  const violations = [];
  const baselined = [];
  const seenBaselineKeys = new Set();
  let citationCount = 0;
  let fileCount = 0;

  for (const dir of scanDirs) {
    for (const file of walk(join(repoRoot, dir))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('ADR-')) continue;
      fileCount++;
      for (const cite of extractCitations(text)) {
        citationCount++;
        const key = baselineKey(cite.adr, cite.amendment);
        const isBaselined = BASELINE_KEYS.has(key);
        const record = (v) => {
          if (isBaselined) {
            seenBaselineKeys.add(key);
            baselined.push(v);
          } else {
            violations.push(v);
          }
        };

        const entry = index.get(cite.adr);
        if (!entry) {
          if (Object.prototype.hasOwnProperty.call(FLEET_ADRS, cite.adr)) continue;
          record({
            file: relative(repoRoot, file),
            line: cite.line,
            adr: cite.adr,
            amendment: cite.amendment,
            kind: 'missing-adr',
            message: `cites ADR-${cite.adr}, which has no file in docs/adr/. If it is a fleet ADR from another repo, add it to FLEET_ADRS in scripts/check-adr-citations.mjs with its path.`,
          });
          continue;
        }
        if (cite.amendment !== null && !entry.amendments.has(cite.amendment)) {
          const have = [...entry.amendments].sort((a, b) => a - b);
          record({
            file: relative(repoRoot, file),
            line: cite.line,
            adr: cite.adr,
            amendment: cite.amendment,
            kind: 'missing-amendment',
            message: `cites ADR-${cite.adr} Amendment ${cite.amendment}, but ${entry.files.join(' + ')} declare${
              entry.files.length > 1 ? '' : 's'
            } ${
              have.length ? `Amendment ${have.join(', ')}` : 'no numbered amendments'
            }. Either write the amendment or correct the citation.`,
          });
        }
      }
    }
  }

  // The ratchet: a baseline entry nobody violates any more is dead weight that
  // makes the list look worse than reality. Removing it is the point.
  const staleBaseline = KNOWN_UNRESOLVED.filter(
    (e) => !seenBaselineKeys.has(baselineKey(e.adr, e.amendment)),
  );

  return {
    violations,
    baselined,
    staleBaseline,
    stats: { filesScanned: fileCount, citations: citationCount, adrsIndexed: index.size },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href.replace(/\\/g, '/');

if (isMain) {
  const { violations, baselined, staleBaseline, stats } = checkAdrCitations({
    repoRoot: process.cwd(),
  });

  if (baselined.length > 0) {
    console.log(
      `· ${baselined.length} citation(s) against ${KNOWN_UNRESOLVED.length} BASELINED amendments ` +
        `(pre-existing drift, tracked in docs/adr/PROMISES.md — the list may only shrink).`,
    );
  }

  const collisions = findDuplicateAdrNumbers(join(process.cwd(), 'docs', 'adr'));
  for (const c of collisions) {
    console.error(
      `✗ ADR number collision: ${c.files.length} primary files claim ADR-${c.number}:\n` +
        c.files.map((f) => `    ${f}`).join('\n') +
        `\n    A citation to ADR-${c.number} now resolves to two different decisions.\n` +
        `    The number belongs to the first PUSHED reference; the later claim renumbers.\n`,
    );
  }

  if (violations.length === 0 && staleBaseline.length === 0 && collisions.length === 0) {
    console.log(
      `✓ ADR citations resolve — ${stats.citations} citations across ${stats.filesScanned} files against ${stats.adrsIndexed} ADRs.`,
    );
    process.exit(0);
  }

  for (const e of staleBaseline) {
    console.error(
      `✗ stale baseline entry: ADR-${e.adr} Amendment ${e.amendment} is no longer cited or now resolves.\n` +
        `    Delete it from KNOWN_UNRESOLVED in scripts/check-adr-citations.mjs — the baseline must only shrink.\n`,
    );
  }

  if (violations.length > 0) {
    console.error(`✗ ${violations.length} unresolved ADR citation(s):\n`);
  }
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.message}\n`);
  }
  console.error(
    'A citation is a promise that a reason is written down. When it does not resolve,\n' +
      'the next author cannot tell whether the constraint is real, superseded, or imagined.\n',
  );
  process.exit(1);
}
