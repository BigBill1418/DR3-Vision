#!/usr/bin/env node
// ADR promise extractor + registry check (ADR-0098 C2; prescribed by ADR-0094 §5 P5).
//
// THE DEFECT THIS ADDRESSES. ADR-0094 §3 RC-4 counted roughly 42 forward-looking
// commitments across the 13 floor ADRs. Not one carried an issue number. About
// half named `docs/OPEN-ITEMS.md`; the other half were pure prose in a
// Consequences block with no handle at all. The cost was not theoretical:
//
//   - the health pill, promised in ADR-0019.1 §4 and then CITED AS A LIVE CONTROL
//     by two later ADRs, sat unbuilt for four months with no visible symptom;
//   - the 08:30 auto-override safety net sat dead at both sites for a month;
//   - escalation pages were silently dropped for a week while the counters
//     reported the attempts as successes.
//
// Each shares one shape: a promise whose failure mode is SILENCE. Nobody notices
// a page that did not arrive, and nobody notices a commitment that was never
// picked up.
//
// WHAT THIS IS NOT. It is not an attempt to understand English. It is a
// deliberately narrow keyword pass tuned for PRECISION over recall: a noisy
// linter gets disabled, and a disabled linter is worth less than no linter at
// all. It will miss promises. That is the accepted trade — see ADR-0098 §4.
//
//   node scripts/extract-adr-promises.mjs            # list candidates
//   node scripts/extract-adr-promises.mjs --check    # registry coverage (warns)
//
// The `--check` mode NEVER exits non-zero for missing coverage. It is advisory by
// design, following the same reasoning as the `migrate diff` step in ci.yml:
// a hard gate that reds-on-arrival gets bypassed, and bypassing it would mask the
// citation resolver, which IS a hard gate.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADRs numbered at or below this are grandfathered: they predate the registry and
 * are only reported if they already carry a row. Anything NEWER that states a
 * promise without a registry row is what `--check` warns about.
 */
export const REGISTRY_EPOCH_ADR = 98;

/**
 * The promise vocabulary, tuned against the real corpus (104 ADRs).
 *
 * Every pattern here was kept only because a manual read of its hits was
 * overwhelmingly genuine forward commitments. Patterns that read well in the
 * abstract but produced mostly descriptive prose — bare `should be`, bare
 * `will be`, bare `planned`, bare `pending` — were REMOVED after audit. They are
 * listed in ADR-0098 §4 as deliberate misses rather than silently dropped.
 */
export const PROMISE_MARKERS = [
  { name: 'not-in-this-change', re: /\bnot\s+(?:in\s+this\s+change|touched\s+here|done\s+here|fixed\s+here|addressed\s+here)\b/i },
  { name: 'follow-up', re: /\b(?:noted\s+for\s+follow-up|for\s+follow-up|follow-on|next\s+iteration)\b/i },
  { name: 'recorded-not-built', re: /\brecorded,?\s+not\s+built\b/i },
  { name: 'still-open', re: /\b(?:still\s+open|remains?\s+open)\b/i },
  { name: 'out-of-scope', re: /\bout\s+of\s+scope\s+(?:here|for\s+this)\b/i },
  { name: 'deferred', re: /\bdeferred\b/i },
  { name: 'not-yet', re: /\bnot\s+yet\s+(?:built|implemented|wired|shipped|written|enabled|applied)\b/i },
  { name: 'should-be-rederived', re: /\bshould\s+be\s+re-?derived\b/i },
  { name: 'will-need', re: /\bwill\s+(?:need|have)\s+to\b/i },
  { name: 'candidate-for', re: /\bis\s+a\s+candidate\s+for\b/i },
  { name: 'todo', re: /\bTODO\b/ },
  // REMOVED after audit: `gated on`. It read like a commitment ("gated on Bill's
  // decision") but in this corpus it almost always describes a ROLLOUT FLAG
  // ("gated on `ipad_queue`") — 6 hits, 6 false positives, 0 real promises.
];

/**
 * Lines that look like promises but are records of promises ALREADY KEPT. Without
 * this the registry fills with closed items and stops being read.
 */
// Two regexes on purpose. The first is CASE-SENSITIVE: this repo writes closure
// as a shouted status marker (`DONE`, `STILL OPEN`), and lowercasing it would
// suppress a genuine promise in any sentence containing the ordinary word
// "shipped" or "closed" — a recall loss disguised as precision.
const RESOLVED_STATUS = /\b(?:DONE|RESOLVED|CLOSED|SHIPPED|LANDED)\b/;
const RESOLVED_PHRASES =
  /\b(?:now\s+exists|is\s+now\s+done|no\s+longer|was\s+deferred|were\s+deferred|has\s+since)\b/i;

/** Extract promise candidates from one ADR's text. */
export function extractPromises(text) {
  const out = [];
  const lines = text.split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Fenced code: a `TODO` in a code sample is not a commitment.
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Blockquotes are QUOTATIONS — of another ADR, of Bill, of a maintainer. A
    // quoted promise belongs to whoever made it, not to this ADR.
    if (line.startsWith('>')) continue;

    // Headings are titles, and table rows are usually the OPEN-ITEMS-style
    // registers this tool is meant to complement rather than re-scrape.
    if (line.startsWith('#') || line.startsWith('|')) continue;

    if (!line || line.length < 20) continue;
    if (RESOLVED_STATUS.test(line) || RESOLVED_PHRASES.test(line)) continue;

    for (const marker of PROMISE_MARKERS) {
      if (marker.re.test(line)) {
        out.push({ line: i + 1, marker: marker.name, text: line });
        break; // one candidate per line; the first marker names it
      }
    }
  }
  return out;
}

/** ADR number → promise candidates, across the whole ADR directory. */
export function collectPromises(adrDir) {
  const byAdr = new Map();
  for (const file of readdirSync(adrDir).sort()) {
    const m = /^(\d{4}(?:\.\d+)?)[-.]/.exec(file);
    if (!m || !file.endsWith('.md')) continue;
    const promises = extractPromises(readFileSync(join(adrDir, file), 'utf8'));
    if (promises.length === 0) continue;
    const number = m[1];
    const entry = byAdr.get(number) ?? { number, files: [], promises: [] };
    entry.files.push(file);
    entry.promises.push(...promises.map((p) => ({ ...p, file })));
    byAdr.set(number, entry);
  }
  return byAdr;
}

/** ADR numbers that have at least one row in PROMISES.md. */
export function registeredAdrs(registryPath) {
  let text;
  try {
    text = readFileSync(registryPath, 'utf8');
  } catch {
    return new Set();
  }
  const found = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    for (const m of line.matchAll(/ADR-(\d{4}(?:\.\d+)?)/g)) found.add(m[1]);
  }
  return found;
}

/**
 * Which ADRs newer than the epoch state a promise but carry no registry row.
 * This is the advisory signal; it never fails a build.
 */
export function checkRegistryCoverage({
  repoRoot = process.cwd(),
  adrDir = join(repoRoot, 'docs', 'adr'),
  registryPath = join(repoRoot, 'docs', 'adr', 'PROMISES.md'),
} = {}) {
  const byAdr = collectPromises(adrDir);
  const registered = registeredAdrs(registryPath);
  const uncovered = [];
  for (const [number, entry] of byAdr) {
    if (parseFloat(number) <= REGISTRY_EPOCH_ADR) continue; // grandfathered
    if (registered.has(number)) continue;
    uncovered.push(entry);
  }
  return {
    uncovered,
    stats: {
      adrsWithPromises: byAdr.size,
      totalCandidates: [...byAdr.values()].reduce((n, e) => n + e.promises.length, 0),
      registeredAdrs: registered.size,
    },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const invoked = process.argv[1] ?? '';
const isMain = invoked.endsWith('extract-adr-promises.mjs');

if (isMain) {
  const repoRoot = process.cwd();
  const adrDir = join(repoRoot, 'docs', 'adr');

  if (process.argv.includes('--check')) {
    const { uncovered, stats } = checkRegistryCoverage({ repoRoot });
    console.log(
      `promise registry: ${stats.totalCandidates} candidates across ${stats.adrsWithPromises} ADRs; ` +
        `${stats.registeredAdrs} ADRs have rows in docs/adr/PROMISES.md.`,
    );
    if (uncovered.length === 0) {
      console.log('✓ every ADR newer than the registry epoch that states a promise has a row.');
      process.exit(0);
    }
    for (const entry of uncovered) {
      const sample = entry.promises[0];
      // GitHub Actions renders this as an annotation; locally it is just a line.
      console.log(
        `::warning file=docs/adr/${sample.file}::ADR-${entry.number} states ${entry.promises.length} ` +
          `forward commitment(s) but has no row in docs/adr/PROMISES.md. ` +
          `First: "${sample.text.slice(0, 140)}"`,
      );
    }
    console.log(
      `\n${uncovered.length} ADR(s) without registry rows. This is a WARNING, not a failure — ` +
        `a promise with no handle is how the health pill stayed unbuilt for four months (ADR-0094 §3 RC-4).`,
    );
    process.exit(0);
  }

  const byAdr = collectPromises(adrDir);
  for (const [number, entry] of [...byAdr].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    console.log(`\nADR-${number}  (${entry.promises.length})`);
    for (const p of entry.promises) {
      console.log(`  ${p.file}:${p.line}  [${p.marker}]`);
      console.log(`    ${p.text.slice(0, 160)}`);
    }
  }
  console.log(
    `\n${[...byAdr.values()].reduce((n, e) => n + e.promises.length, 0)} candidates across ${byAdr.size} ADRs.`,
  );
}
