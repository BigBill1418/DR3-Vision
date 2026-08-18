// ADR-0084 — the guard that makes omitting the void filter impossible.
//
// ## Why prose was not enough
//
// The audit behind ADR-0084 found THIRTEEN non-test read sites on
// `site_inventory_snapshots`, across five directories, written over eight months
// by passes that did not know about each other. A missed one does not return a
// slightly wrong list: `onHand` anchors the ENTIRE floor on a count a human has
// said was a mistake, and every COR, EOD and MRC billing figure is computed
// forward from it. Nothing surfaces that. A sentence in an ADR asking the next
// author to remember `voided_at: null` is a sentence the next author never reads.
//
// So this test reads the ACTUAL SOURCE off disk, finds every
// `siteInventorySnapshot` read call in `src/`, and fails naming any whose
// argument does not carry the centralised filter. It is a control, not a
// courtesy: it fails the build.
//
// ## Three things that keep the guard itself honest
//
//   1. **It self-tests.** `finds a violation in a deliberately unfiltered
//      snippet` runs the same matcher over fabricated source containing one
//      compliant and one non-compliant call and asserts it flags exactly the
//      non-compliant one. A guard nobody has ever seen fail is a guard nobody
//      has evidence works.
//   2. **It asserts its own coverage.** A regex that stops matching — a rename, a
//      Prisma client accessor change, a bad glob — makes the scan return nothing,
//      and a scan of nothing has no violations, so it reports GREEN while
//      measuring NOTHING. `inspects every known call site` pins the count.
//   3. **Its allowlist has teeth.** Every intentional exception must still be
//      MATCHED (a stale entry pointing at a moved file fails, rather than
//      silently widening the exemption) and each carries a `mustContain` token
//      proving the compensating control is still in the file.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = join(REPO_ROOT, 'src');

/**
 * Prisma read methods. Writes (`create`, `update`, `updateMany`, `upsert`,
 * `delete`) are excluded on purpose: a write does not SELECT an anchor, and the
 * void write itself must obviously be allowed to name a voided row.
 */
const READ_METHODS = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
] as const;

const CALL_RE = new RegExp(
  String.raw`siteInventorySnapshot\s*\.\s*(${READ_METHODS.join('|')})\s*\(`,
  'g',
);

/** Either spelling of the centralised filter counts. Nothing else does. */
const FILTER_TOKENS = ['NOT_VOIDED', 'notVoidedSnapshotWhere'] as const;

interface CallSite {
  file: string;
  method: string;
  /** 1-based line of the call, for a message a human can act on. */
  line: number;
  /** The full argument text, parens-balanced. */
  args: string;
}

/**
 * The argument list starting at `openParen`, parens-balanced — with COMMENTS
 * STRIPPED OUT of the returned text.
 *
 * Stripping the comments is the load-bearing part, and it was found the hard
 * way. The first version of this function kept them, and every reader in this
 * repo documents its filter in a comment ON the call:
 *
 *     prisma.siteInventorySnapshot.findFirst({
 *       // ADR-0084 — `NOT_VOIDED` first, and it is not optional here...
 *       where: { site_id: siteId, ... },      // ← filter actually MISSING
 *
 * So the guard read the token out of the prose explaining the token, and stayed
 * GREEN against a `running-balance.ts` with the filter deleted — while the
 * behavioural suite went red naming the voided count's total. A guard that
 * matches its own documentation is exactly the "reports green while measuring
 * nothing" failure it exists to prevent. Comments are code to a human and noise
 * to this check.
 *
 * String and template literals are skipped for paren-balancing (a `)` inside one
 * must not close the call early) but KEPT in the text — a filter cannot hide in
 * a string, and dropping them would let a `NOT_VOIDED` in real code go unseen.
 */
function readArgs(src: string, openParen: number): string {
  let depth = 0;
  let i = openParen;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return out;
    }
    i += 1;
  }
  return out;
}

/** Every `siteInventorySnapshot` read call in one source string. */
export function callSitesIn(file: string, src: string): CallSite[] {
  const out: CallSite[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(src)) !== null) {
    const openParen = src.indexOf('(', m.index + m[0].length - 1);
    out.push({
      file,
      method: m[1] as string,
      line: src.slice(0, m.index).split('\n').length,
      args: readArgs(src, openParen),
    });
  }
  return out;
}

function carriesFilter(site: CallSite): boolean {
  return FILTER_TOKENS.some((tok) => site.args.includes(tok));
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    if (/\.db\.test\.ts$/.test(name)) continue;
    acc.push(full);
  }
  return acc;
}

function scanRepo(): CallSite[] {
  return walk(SRC).flatMap((f) =>
    callSitesIn(relative(REPO_ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The allowlist — the DELIBERATE exceptions, each with its compensating control
// ─────────────────────────────────────────────────────────────────────────
//
// Adding an entry here is a decision, not a fix. Each says WHY the filter is
// wrong for that call site and names a `mustContain` token that proves the thing
// standing in its place is still there.

interface Exception {
  file: string;
  method: string;
  why: string;
  /** Token whose presence in the FILE proves the compensating control survives. */
  mustContain: string;
}

const ALLOWLIST: Exception[] = [
  {
    file: 'src/app/admin/inventory/anchors/page.tsx',
    method: 'findMany',
    why:
      'THE recovery surface. Hiding voided counts here reproduces exactly the ' +
      'problem soft-voiding exists to avoid — a number the floor entered vanishes ' +
      'and the history stops explaining what happened. Shown struck through and ' +
      'badged instead; `Re-activate` is withdrawn on voided rows.',
    mustContain: 'voided_at: true',
  },
  {
    file: 'src/app/api/manager/[site]/snapshots/route.ts',
    method: 'findMany',
    why:
      'A HISTORY list, not an anchor selector — nothing is computed from what it ' +
      'returns. Dropping voided rows would delete a count the office knows was ' +
      'taken from the only manager-facing list of counts. The void state is ' +
      'surfaced to the client instead.',
    mustContain: 'voided_at: true',
  },
  {
    file: 'src/app/api/admin/inventory/anchors/reactivate/route.ts',
    method: 'findUnique',
    why:
      '`findUnique` accepts only unique fields in its where-clause, so the filter ' +
      'cannot live in the query. The row is fetched by id and REFUSED afterwards ' +
      '(422 `snapshot_voided`) — re-activation copies figures forward into a new ' +
      'live anchor, so allowing a voided source would launder a withdrawn number ' +
      'back into the chain.',
    mustContain: 'isVoidedSnapshot(restoreFrom)',
  },
  {
    file: 'src/lib/inventory/void-count.ts',
    method: 'findUnique',
    why:
      'The void service MUST be able to see an already-voided row — that is how ' +
      'the idempotent double-tap returns a no-op success instead of a 404. ' +
      'Filtering here would make the second tap look like a missing count.',
    mustContain: 'alreadyVoided: true',
  },
  {
    file: 'src/lib/inventory/void-count.ts',
    method: 'findUniqueOrThrow',
    why:
      'Reached only when the `NOT_VOIDED`-guarded `updateMany` matched zero rows, ' +
      'i.e. a concurrent void won the race. It reads that winner`s `voided_at` to ' +
      'report it. By construction the row IS voided; filtering it out would throw.',
    mustContain: 'count === 0',
  },
  {
    file: 'src/lib/inventory/correct-count.ts',
    method: 'findUnique',
    why:
      'ADR-0105 — the manager correction service. Same `findUnique` constraint as ' +
      'the reactivate route: only unique fields may appear in the where-clause. ' +
      'The compensating control is STRICTER than the filter would be — the row is ' +
      'fetched by id and refused post-read with 422 `snapshot_voided`, whereas ' +
      'filtering would report "not found" and send the manager hunting for a row ' +
      'that is on their screen. Its `listCorrectableCountsAtSite` findMany, which ' +
      'IS an eligibility selector, carries NOT_VOIDED and is not exempted here.',
    mustContain: 'throw new SnapshotAlreadyVoidedError()',
  },
];

function isAllowed(site: CallSite): Exception | undefined {
  return ALLOWLIST.find((a) => a.file === site.file && a.method === site.method);
}

/**
 * The number of read call sites that existed when this guard was written (10
 * filtered + 5 allowlisted). A floor, not an equality: new readers are expected,
 * and each must either carry the filter or earn an allowlist entry. Its job is
 * to fail LOUDLY if the scan ever matches nothing — a silent zero would report
 * green while measuring nothing at all.
 */
const KNOWN_CALL_SITE_FLOOR = 15;

describe('ADR-0084 — every siteInventorySnapshot reader carries the void filter', () => {
  const sites = scanRepo();

  it('inspects every known call site (a scan that matches nothing must fail)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(KNOWN_CALL_SITE_FLOOR);
    // And it genuinely reached the anchor selector, not just some file.
    expect(
      sites.some(
        (s) => s.file === 'src/lib/inventory/running-balance.ts' && s.method === 'findFirst',
      ),
    ).toBe(true);
  });

  it('no reader omits NOT_VOIDED without an allowlist entry', () => {
    const violations = sites
      .filter((s) => !carriesFilter(s) && !isAllowed(s))
      .map(
        (s) =>
          `${s.file}:${s.line} siteInventorySnapshot.${s.method}() — where-clause has no NOT_VOIDED`,
      );
    expect(violations).toEqual([]);
  });

  it('every allowlist entry still matches a real call site AND keeps its control', () => {
    for (const a of ALLOWLIST) {
      const matched = sites.filter((s) => s.file === a.file && s.method === a.method);
      // A stale entry (file moved/renamed) must FAIL rather than silently
      // exempting nothing while looking like it exempts something.
      expect(
        matched.length,
        `allowlist entry matches no call site: ${a.file} .${a.method}()`,
      ).toBeGreaterThan(0);
      const src = readFileSync(join(REPO_ROOT, a.file), 'utf8');
      expect(
        src.includes(a.mustContain),
        `${a.file} lost its compensating control: ${a.mustContain}`,
      ).toBe(true);
    }
  });

  it('the prod remediation SQL filters voided counts too', () => {
    // `scripts/fix-woodland-inbound.sh` hand-reproduces the anchor query against
    // the production database. It is outside `src/` and outside Prisma, so the
    // scan above cannot see it — this is its guard.
    const sh = readFileSync(join(REPO_ROOT, 'scripts/fix-woodland-inbound.sh'), 'utf8');
    const anchorCte = sh.slice(sh.indexOf('FROM site_inventory_snapshots'));
    expect(anchorCte.slice(0, 200)).toContain('voided_at IS NULL');
  });
});

describe('the guard itself — proof it can fail', () => {
  const COMPLIANT = `
    const anchor = await prisma.siteInventorySnapshot.findFirst({
      where: { ...NOT_VOIDED, site_id: siteId, snapshot_kind: 'physical' },
      orderBy: [{ snapshot_at: 'desc' }],
    });
  `;
  const UNFILTERED = `
    const anchor = await prisma.siteInventorySnapshot.findFirst({
      where: { site_id: siteId, snapshot_kind: 'physical' },
      orderBy: [{ snapshot_at: 'desc' }],
    });
  `;

  it('finds a violation in a deliberately unfiltered snippet, and none in a filtered one', () => {
    const bad = callSitesIn('synthetic/bad.ts', UNFILTERED);
    const good = callSitesIn('synthetic/good.ts', COMPLIANT);

    expect(bad).toHaveLength(1);
    expect(good).toHaveLength(1);
    expect(bad.filter((s) => !carriesFilter(s))).toHaveLength(1);
    expect(good.filter((s) => !carriesFilter(s))).toHaveLength(0);
  });

  it('is not fooled by the token appearing in a comment ABOVE the call', () => {
    // The matcher reads the ARGUMENT text, so a mention outside the call does not
    // satisfy it — otherwise "// TODO: add NOT_VOIDED" at the top of a file would
    // exempt every reader in it.
    const decoy = `
      // NOT_VOIDED belongs here one day
      const anchor = await prisma.siteInventorySnapshot.findFirst({
        where: { site_id: siteId },
      });
    `;
    const found = callSitesIn('synthetic/decoy.ts', decoy);
    expect(found).toHaveLength(1);
    expect(carriesFilter(found[0] as CallSite)).toBe(false);
  });

  it('is not fooled by the token appearing in a comment INSIDE the call', () => {
    // THE REGRESSION THAT ALMOST SHIPPED. Every reader in this repo documents its
    // filter in a line comment on the call itself, so a matcher that reads
    // comments reads the token out of the prose describing it — and reports green
    // against source with the filter deleted. Verified empirically: with
    // `...NOT_VOIDED` removed from `running-balance.ts` the earlier version of
    // this guard passed 8/8 while `void-count.test.ts` failed 4 tests naming the
    // voided count's total. Both shapes below must be seen as UNFILTERED.
    const lineComment = `
      const anchor = await prisma.siteInventorySnapshot.findFirst({
        // ADR-0084 — NOT_VOIDED first, and it is not optional here.
        where: { site_id: siteId, snapshot_kind: 'physical' },
      });
    `;
    const blockComment = `
      const anchor = await prisma.siteInventorySnapshot.findFirst({
        /* uses notVoidedSnapshotWhere elsewhere */
        where: { site_id: siteId },
      });
    `;
    for (const [name, src] of [
      ['synthetic/line.ts', lineComment],
      ['synthetic/block.ts', blockComment],
    ] as const) {
      const found = callSitesIn(name, src);
      expect(found, name).toHaveLength(1);
      expect(carriesFilter(found[0] as CallSite), `${name} must read as UNFILTERED`).toBe(false);
    }
  });

  it('survives a `)` inside a string in the call arguments', () => {
    const tricky = `
      await prisma.siteInventorySnapshot.count({
        where: { ...NOT_VOIDED, site_id: ')' },
      });
    `;
    const found = callSitesIn('synthetic/tricky.ts', tricky);
    expect(found).toHaveLength(1);
    expect(carriesFilter(found[0] as CallSite)).toBe(true);
  });

  it('matches a call split across lines (tx.siteInventorySnapshot\\n  .findMany)', () => {
    const split = `
      tx.siteInventorySnapshot
        .findMany({ where: notVoidedSnapshotWhere({ site_id: siteId }) })
        .then((r) => r);
    `;
    const found = callSitesIn('synthetic/split.ts', split);
    expect(found).toHaveLength(1);
    expect(carriesFilter(found[0] as CallSite)).toBe(true);
  });
});
