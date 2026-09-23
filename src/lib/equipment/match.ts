// ADR-0135 B — ONE unit-number-aware equipment matcher, shared by the server
// create gate, the resolve panel's search, the approver's picker and the admin
// duplicates queue.
//
// PURE. No Prisma, no Node APIs: the approver's picker (`ApQueueClient.tsx`) and
// the resolve panel run this in the browser, and the server gate runs the SAME
// function over the SAME rows. Two definitions would be two answers to "is this
// already in the fleet?", which is how the registry drifted in the first place.
//
// WHAT IT FIXES (ADR-0135 §2, holes 2 and 5). The old detector compared WHOLE
// canonical names, so `161053.` never met `161053 — Freightliner Semi Truck`,
// and the picker's raw `includes()` never matched `Trailer # 19` to `Trailer #19`.
// A human identifies these assets by their UNIT NUMBER; so does this.
//
// THE GUARDRAIL (ADR-0087, carried into ADR-0135 §4): the key PROPOSES, a person
// DISPOSES. `-` is load-bearing in this fleet — `21`, `21-27` and `21-48` are
// three trailers, and `48-68` is not `4868` — so a hyphen between two
// alphanumerics is part of the unit key and never stripped. `#` and the space
// after it are NOT: `Trailer # 19`, `Trailer #19` and `Trailer 19` all carry
// unit `19`. Where that is wrong (ADR-0087 notes `Truck 9`/`Truck #9` are two
// trucks), the server gate SHOWS the match and offers an audited override; it
// never silently merges anything.

/** A registry row as the matcher needs it. Structural, so any caller's row fits. */
export interface MatchableEquipment {
  id: string;
  displayName: string;
  category: string;
  /** `null` = fleet-wide (ADR-0135 §cross-site): the asset has no home yard. */
  siteId: string | null;
  isActive: boolean;
  mergedIntoId: string | null;
  /** ADR-0135 D — real identifier columns, when the row was created structured. */
  unitNumber?: string | null | undefined;
  vinSerial?: string | null | undefined;
  assetType?: string | null | undefined;
}

export type MatchReason =
  /** Same name once case, spacing and punctuation are ignored (`terex` / `Terex`). */
  | 'same_name'
  /** Same VIN / serial — the strongest identity there is. */
  | 'same_vin'
  /** Same unit number (`161053.` / `161053 — Freightliner …`). */
  | 'same_unit'
  /** Shares words with the query — a search hit, never a duplicate verdict. */
  | 'words';

export interface EquipmentMatch<T extends MatchableEquipment = MatchableEquipment> {
  row: T;
  reason: MatchReason;
  /** Higher is better. Stable ordering key for every surface. */
  score: number;
  /**
   * True when this match is strong enough that CREATING a new row would
   * probably duplicate it — the server's hard gate refuses on any such match
   * unless the caller sends an explicit, reasoned override.
   */
  probableDuplicate: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Normalisation
// ────────────────────────────────────────────────────────────────────

/** Case/whitespace/punctuation-insensitive whole-name key (ADR-0075's rule). */
export function nameKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Uppercase, NFKC, unify dash look-alikes, and glue `#` onto the number after it.
 *
 * Unicode dashes (–, —, ‒, −) are SEPARATORS in this registry — the seed's
 * `<unit> — <make> <type>` convention uses an em dash with spaces around it —
 * so they become spaces. Only the ASCII hyphen between two alphanumerics is a
 * unit character.
 */
function prepare(raw: string): string {
  return raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‒–—―−]/g, ' ')
    .replace(/#\s*(?=[A-Z0-9])/g, '#');
}

/** O→0 and I→1 inside an otherwise-numeric token (`16I053` → `161053`). */
function fixOcrLookalikes(token: string): string {
  const swapped = token.replace(/O/g, '0').replace(/I/g, '1');
  return /^[0-9-]+$/.test(swapped) ? swapped : token;
}

/**
 * The unit-number tokens in a free-text name, in order, de-duplicated.
 *
 * A token is a run of `[A-Z0-9-]` (after `#` is glued on and stripped) that
 * contains at least one digit. A hyphen is kept only BETWEEN alphanumerics:
 * `32-48` stays `32-48`; `- 48` and `48-` lose it.
 *
 *   `161053.`                                  → ['161053']
 *   `161053 — Freightliner Semi Truck (Day Cab S/A)` → ['161053']
 *   `trailer 32-48`                            → ['32-48']
 *   `Trailer # 19` / `Trailer #19`             → ['19']
 *   `EQ24 Terex Shredder`                      → ['EQ24']
 *   `48-68 trailer` vs `4868 — Fruehauf 28 Ft` → ['48-68'] vs ['4868'] (a length is skipped)
 */
export function unitTokens(raw: string): string[] {
  const out: string[] = [];
  const text = prepare(raw);
  for (const m of text.matchAll(/[A-Z0-9#]+(?:-[A-Z0-9]+)*/g)) {
    const token = fixOcrLookalikes(m[0].replace(/#/g, ''));
    if (!token || !/[0-9]/.test(token) || out.includes(token)) continue;
    // A length is not an identity: `28 Ft`, `53'`, `48FT`.
    const after = text.slice((m.index ?? 0) + m[0].length);
    if (/^FT\b/.test(token.replace(/^[0-9]+/, '')) || /^\s*(?:FT\b|FOOT\b|FEET\b|')/.test(after)) {
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * The unit numbers that IDENTIFY a registry row. For a seed-format name
 * (`<unit> — <make> <type>`) that is the part before the spaced dash only, so
 * a number in the description (`4868 — Fruehauf 28 Ft …`, `… (Day Cab S/A)`)
 * cannot make an unrelated query look like a duplicate. Other names fall back to
 * every unit token they carry.
 */
export function identifyingUnits(name: string, unitNumber?: string | null): string[] {
  const col = unitNumber ? unitKey(unitNumber) : '';
  const head = name.split(/\s[\u2012\u2013\u2014\u2015\u2212-]\s/)[0] ?? name;
  const fromName = head !== name ? unitTokens(head) : unitTokens(name);
  return col && !fromName.includes(col) ? [col, ...fromName] : fromName;
}

/** Filler between a class word and its number: `Trailer Number #7677`, `Unit No. 5`. */
const PREFIX_FILLER = new Set(['NUMBER', 'NO', 'NUM', 'UNIT', 'NBR']);

/**
 * The fleet-class word written directly in front of `unit` in the identifying
 * part of a name (`Truck 12 — Isuzu …` → `TRUCK`; `Trailer Number #7677` →
 * `TRAILER`), singularised; null when the number stands alone (`161053 — …`).
 */
export function unitPrefix(name: string, unit: string): string | null {
  const head = name.split(/\s[\u2012\u2013\u2014\u2015\u2212-]\s/)[0] ?? name;
  const toks = prepare(head).match(/[A-Z0-9#]+(?:-[A-Z0-9]+)*/g) ?? [];
  const at = toks.findIndex((t) => fixOcrLookalikes(t.replace(/#/g, '')) === unit);
  for (let i = at - 1; i >= 0; i -= 1) {
    const t = toks[i] ?? '';
    if (t === '#' || PREFIX_FILLER.has(t)) continue;
    return /^[A-Z]+$/.test(t) ? t.replace(/S$/, '') : null;
  }
  return null;
}

/** The canonical unit key for a single typed unit number, or '' when there is none. */
export function unitKey(raw: string): string {
  return unitTokens(raw)[0] ?? '';
}

/** Words that describe WHAT an asset is. Order matters: first match wins. */
const TYPE_WORDS: readonly [RegExp, string][] = [
  [/\bTRAILERS?\b/, 'trailer'],
  [/\bFORK ?LIFTS?\b/, 'forklift'],
  [/\bBALERS?\b/, 'baler'],
  [/\b(?:TEREX|SHREDDER|SHEAR)\b/, 'shredder'],
  [/\b(?:TRUCKS?|TRACTORS?|SEMI|VANS?|PICKUP)\b/, 'truck'],
];

/**
 * The coarse physical type of an asset — `trailer`, `forklift`, `baler`,
 * `shredder`, `truck` — or null when neither the structured column nor the name
 * says. Used only to stop a SHORT unit number (`19`, `F9`) from flagging a
 * trailer as a duplicate of a truck.
 */
export function assetKind(name: string, assetType?: string | null): string | null {
  for (const source of [assetType ?? '', name]) {
    const up = prepare(source);
    for (const [re, kind] of TYPE_WORDS) if (re.test(up)) return kind;
  }
  return null;
}

/** Descriptive words (letters only, ≥3 chars, not filler) for search ranking. */
const STOP = new Set(['THE', 'AND', 'FOR', 'WITH', 'NUMBER', 'UNIT', 'FROM', 'FT']);
function words(raw: string): string[] {
  const out: string[] = [];
  for (const m of prepare(raw).matchAll(/[A-Z]{3,}/g)) {
    if (!STOP.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/**
 * A unit number short enough to be shared by unrelated assets (`3`, `19`, `F9`).
 * These only count as a probable duplicate when the two assets are the same kind.
 */
function isShortUnit(token: string): boolean {
  return token.replace(/[^A-Z0-9]/g, '').length <= 2;
}

// ────────────────────────────────────────────────────────────────────
// The matcher
// ────────────────────────────────────────────────────────────────────

export interface MatchQuery {
  /** Whatever the person typed, or the generated display name. */
  text: string;
  /** A structured unit number, when the caller has one. Joins the text's own tokens. */
  unitNumber?: string | null | undefined;
  vinSerial?: string | null | undefined;
  /** Structured type (e.g. `Trailer`), for the short-unit kind check. */
  assetType?: string | null | undefined;
  category?: string | null | undefined;
}

export interface MatchOptions {
  /** Default 25. The resolve panel shows a short list; the duplicates queue wants all. */
  limit?: number | undefined;
  /** Include plain word matches (search). Default true. The create gate turns it off. */
  includeWordMatches?: boolean | undefined;
}

function rowUnits(row: MatchableEquipment): string[] {
  return identifyingUnits(row.displayName, row.unitNumber);
}

/**
 * Rank every row against a query. Merged-away rows are NEVER returned as
 * themselves — a merged loser that matches is replaced by its survivor (ADR-0075
 * keeps the loser's name, so an old spelling still finds the live asset).
 */
export function matchEquipment<T extends MatchableEquipment>(
  query: MatchQuery,
  rows: readonly T[],
  opts: MatchOptions = {},
): EquipmentMatch<T>[] {
  const limit = opts.limit ?? 25;
  const includeWords = opts.includeWordMatches ?? true;

  const qName = nameKey(query.text);
  const qUnits = unitTokens(query.text);
  const structuredUnit = query.unitNumber ? unitKey(query.unitNumber) : '';
  if (structuredUnit && !qUnits.includes(structuredUnit)) qUnits.unshift(structuredUnit);
  const qVin = query.vinSerial ? nameKey(query.vinSerial) : '';
  const qWords = words(query.text);
  const qKind = assetKind(query.text, query.assetType);
  if (!qName && qUnits.length === 0 && !qVin) return [];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const best = new Map<string, EquipmentMatch<T>>();

  for (const raw of rows) {
    const m = scoreRow(raw);
    if (!m) continue;
    // Follow a merged loser to its survivor (one hop; ADR-0075 forbids chains).
    const row = raw.mergedIntoId ? byId.get(raw.mergedIntoId) : raw;
    if (!row || row.mergedIntoId) continue;
    const prev = best.get(row.id);
    if (!prev || m.score > prev.score) best.set(row.id, { ...m, row });
  }

  return [...best.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.row.isActive) - Number(a.row.isActive) ||
        a.row.displayName.localeCompare(b.row.displayName),
    )
    .slice(0, limit);

  function scoreRow(row: T): Omit<EquipmentMatch<T>, 'row'> | null {
    if (qVin && row.vinSerial && nameKey(row.vinSerial) === qVin) {
      return { reason: 'same_vin', score: 1000, probableDuplicate: true };
    }
    if (qName && nameKey(row.displayName) === qName) {
      return { reason: 'same_name', score: 900, probableDuplicate: true };
    }
    // A VIN typed into the name field (production has `1DW1A5321PS807745`).
    if (qVin && nameKey(row.displayName).includes(qVin) && qVin.length >= 8) {
      return { reason: 'same_vin', score: 950, probableDuplicate: true };
    }
    const units = rowUnits(row);
    const shared = qUnits.filter((u) => units.includes(u));
    if (shared.length > 0) {
      const long = shared.some((u) => !isShortUnit(u));
      const rowKind = assetKind(row.displayName, row.assetType);
      const sameKind =
        qKind !== null && rowKind !== null
          ? qKind === rowKind
          : !query.category || query.category === row.category;
      // The fleet-class word in front of the number is part of the identity in
      // this registry: `Truck 12`, `Van 12` and `Bus 12` are three vehicles, and
      // `LIFT 1` is not trailer `1`. Different words → never a probable
      // duplicate (still a search hit). One side bare → a long number still
      // counts; a short one only when the word names the other row's kind.
      const unit = shared[0] ?? '';
      const qPre = unitPrefix(query.text, unit);
      const rPre = unitPrefix(row.displayName, unit);
      let probableDuplicate: boolean;
      if (qPre && rPre) probableDuplicate = qPre === rPre;
      else if (qPre || rPre) {
        const word = (qPre ?? rPre) as string;
        const other = qPre ? rowKind : qKind;
        probableDuplicate = long || (other !== null && assetKind(word) === other);
      } else probableDuplicate = long || sameKind;
      // The query's FIRST unit is what it is "about"; a hit there outranks a hit
      // on an incidental number (a length, `28 Ft`).
      const primary = shared.includes(qUnits[0] ?? '');
      return {
        reason: 'same_unit',
        score: 500 + (primary ? 100 : 0) + (long ? 50 : 0) + (sameKind ? 25 : 0),
        probableDuplicate: probableDuplicate && primary,
      };
    }
    if (!includeWords || qWords.length === 0) return null;
    const rowWords = words(row.displayName);
    const hits = qWords.filter((w) => rowWords.some((rw) => rw.startsWith(w) || w.startsWith(rw)));
    if (hits.length === 0) return null;
    return {
      reason: 'words',
      score: Math.round((100 * hits.length) / qWords.length),
      probableDuplicate: false,
    };
  }
}

/** Only the matches the create gate refuses on. */
export function probableDuplicates<T extends MatchableEquipment>(
  query: MatchQuery,
  rows: readonly T[],
): EquipmentMatch<T>[] {
  return matchEquipment(query, rows, { includeWordMatches: false, limit: 10 }).filter(
    (m) => m.probableDuplicate,
  );
}

/**
 * The picker filter: does `row` answer this typed query?
 *
 * Replaces the approver picker's raw `displayName.toLowerCase().includes(q)`,
 * which missed `Trailer # 19` vs `Trailer #19` and `161053.` vs
 * `161053 — Freightliner …`. A substring hit still counts (typing `fruehauf`
 * must keep working); a unit-number hit is added on top.
 */
export function pickerMatches(query: string, displayName: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (displayName.toLowerCase().includes(q.toLowerCase())) return true;
  const qUnits = unitTokens(q);
  if (qUnits.length === 0) {
    const qKey = nameKey(q);
    return !!qKey && nameKey(displayName).includes(qKey);
  }
  // A query that carries a unit number is judged on unit numbers — a
  // punctuation-blind substring would let `48-68` find `4868`.
  const units = unitTokens(displayName);
  return qUnits.every((u) => units.includes(u));
}

// ────────────────────────────────────────────────────────────────────
// Structured names (ADR-0135 D)
// ────────────────────────────────────────────────────────────────────

/**
 * The seed's naming convention, generated instead of typed:
 * `<unit> — <make> <type>` (`161053 — Freightliner Semi Truck`). Parts that are
 * absent drop out cleanly: no unit → `<make> <type>`; no make → `<unit> — <type>`.
 */
export function generateDisplayName(parts: {
  unitNumber?: string | null | undefined;
  make?: string | null | undefined;
  /** Optional descriptive words between make and type (`48 Ft Swing Door`). */
  details?: string | null | undefined;
  assetType: string;
}): string {
  const tidy = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
  const unit = tidy(parts.unitNumber);
  const rest = [tidy(parts.make), tidy(parts.details), tidy(parts.assetType)]
    .filter(Boolean)
    .join(' ');
  return unit ? (rest ? `${unit} — ${rest}` : unit) : rest;
}
