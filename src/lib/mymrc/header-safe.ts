// Header-safe string coercion for ntfy publishes — the ONE implementation.
//
// This module exists because this defect class has now been re-discovered four
// times on the fleet: the bash/Python helpers were patched 2026-05-06,
// noc-master's Node publisher by ADR-0063 (2026-05-22), and DR3-Vision's own
// `src/lib/ntfy.ts` + `src/lib/mymrc/ntfy.ts` were still unpatched on
// 2026-08-11 (ADR-0019.5). ADR-0063's own open question asked whether the fix
// should become a shared utility "to prevent a fourth re-discovery". It should
// have; it did not; here is the fourth.
//
// Zero imports and zero Node built-ins on purpose: `src/lib/ntfy.ts` documents
// that it must stay bundleable for edge/browser targets, and
// `src/lib/mymrc/ntfy.ts` compiles under `tsconfig.mymrc.json` which has no
// `@/` path alias. A dependency-free module at a relative path is the only
// shape BOTH can consume.
//
// WHY IT LIVES UNDER mymrc/ — this looks like the wrong home for a shared
// utility, and it is, but it is forced. `tsconfig.mymrc.json` sets
// `rootDir: ./src/lib/mymrc`, so the mymrc bundle CANNOT import anything above
// that directory: an earlier placement at `src/lib/ntfy-header-safe.ts` compiled
// fine under the main tsconfig and broke the Docker build at
// `RUN npx tsc --project tsconfig.mymrc.json` with TS6059. Putting the one
// implementation inside the narrower rootDir and re-exporting it upward
// (`src/lib/ntfy-header-safe.ts`) is what lets BOTH bundles share a single copy.
// Moving it back out will break the image build, not the test suite.
//
// CONTRACT VERSION 3 (ADR-0093; fleet contract noc-master ADR-0200 Am.3). v1
// emitted latin-1 and only degraded codepoints above 255. v2 emits PURE ASCII
// and folds accents. v3 closes two blind spots in v2: combining marks are now
// DROPPED rather than degraded (so NFD-decomposed input folds identically to
// NFC), and characters with no NFKD decomposition but an obvious ASCII
// rendering (ß, °, æ, ø, µ, ½ …) are transliterated instead of becoming '?'.
// See the doc comment on `toHeaderSafe` for why.

/**
 * Transliteration table for the Unicode punctuation these titles actually use.
 * Pinned to `toHeaderSafe()` in `noc-master/api/services/notifications.js`, the
 * fleet's reference JS implementation, and to the shared vectors in
 * `noc-master/data/ntfy-header-conformance.json` (vendored for CI at
 * `src/__tests__/ntfy-header-conformance.json`).
 *
 * The table is not redundant with the NFKD fold below: NFKD leaves `×`, `≥` and
 * `•` undecomposed, so without an explicit mapping they would degrade to `?`
 * and lose meaning. Transliteration preserves the sentence; the fold preserves
 * names; the `?` backstop preserves delivery.
 */
const HEADER_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‐-―−]/g, '-'], // hyphen / figure / en / em dash, true minus
  [/[‘’‚‛]/g, "'"], // single curly quotes
  [/[“”„‟]/g, '"'], // double curly quotes
  [/…/g, '...'], // ellipsis
  [/×/g, 'x'], // multiplication sign
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/→/g, '->'], // rightwards arrow — DR3 period labels use it
  [/[    ]/g, ' '], // nbsp / figure / thin / narrow spaces
  [/[•·]/g, '*'], // bullet / middot
  // No NFKD decomposition but an obvious ASCII rendering (ADR-0200 Am.3):
  // without these they degrade to '?' and mangle real words — `Straße` became
  // `Stra?e`, `25°C` became `25?C`.
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/Æ/g, 'AE'],
  [/ø/g, 'o'],
  [/Ø/g, 'O'],
  [/œ/g, 'oe'],
  [/Œ/g, 'OE'],
  [/°/g, 'deg'],
  [/µ/g, 'u'],
  [/½/g, '1/2'],
  [/¼/g, '1/4'],
  [/¾/g, '3/4'],
];

/**
 * Make a string safe to put in an HTTP header value. Output is PURE ASCII.
 *
 * WHY THIS EXISTS — the 2026-08-05 dropped page. Header values are ByteStrings.
 * Node's undici throws
 *
 *   TypeError: Cannot convert argument to a ByteString because the character at
 *   index 43 has a value of 8212 which is greater than 255
 *
 * for any codepoint > 255. Every DR3 alert title contains an em dash (U+2014 =
 * 8212), so `X-Title` threw — and because `buildHeaders` produces the same
 * header for both transports, it threw identically on the primary AND the
 * ntfy.sh fallback, in the same millisecond, WITHOUT OPENING A SOCKET. The
 * publish reported `dropped` while the ntfy server was demonstrably healthy.
 * That is how the stranded-period page for Eugene Period 16 was lost.
 *
 * WHY PURE ASCII AND NOT LATIN-1 (contract v2, ADR-0093) — undici's limit is
 * U+00FF, so v1 stopped there and let `café` through unchanged. But the fleet's
 * HTTP clients do not agree on where the wall is, and the strictest one sets the
 * contract:
 *
 *   python-httpx    raises above U+007F  — ASCII ONLY  <- binding constraint
 *   node-undici     throws  above U+00FF — accepts latin-1
 *   python-urllib   raises  above U+00FF — accepts latin-1
 *   curl/bash       sends raw bytes, unaffected
 *
 * Helix-Hub and other fleet publishers post with httpx, where `café` in a Title
 * raises `UnicodeEncodeError: 'ascii' codec can't encode character 'é'` —
 * the same before-the-socket, kills-both-legs failure the em dash caused here.
 * One fleet, one contract: sanitising to the loosest client's limit means a
 * title that is safe in this repo is a dropped page in the next one. ASCII is
 * the only safe common denominator.
 *
 * ORDER MATTERS: transliterate → strip CR/LF → drop combining marks → fold
 * accents → degrade. Accented letters fold to their ASCII base via NFKD, so
 * `café renewal for José` becomes `cafe renewal for Jose` and stays readable
 * rather than `caf? for Jos?`. An ASCII-only contract is only tolerable to a
 * human reader because names survive it. Only characters with no ASCII base
 * (emoji, CJK) become `?` — an unmapped glyph must degrade to a sendable page,
 * never a lost one.
 *
 * COMBINING MARKS ARE DROPPED, NOT DEGRADED (contract v3, ADR-0200 Am.3) — the
 * same word must not sanitize differently by normal form. `café` composed (NFC,
 * U+00E9) folded to `cafe`, but decomposed (NFD, `e` + U+0301) left the mark as
 * a standalone codepoint with no ASCII base, so it degraded to `?` and produced
 * `cafe?`. Callers do not control the normal form of the strings they are handed.
 *
 * Iteration is over CODEPOINTS, not UTF-16 units: a naive `for (const ch of ...)`
 * over indices would treat an astral emoji as a surrogate pair and emit `??` for
 * one glyph.
 *
 * NOT sanitized: `Authorization` (a bearer is ASCII by construction; mangling it
 * would turn an encoding bug into an auth bug) and the message BODY (sent as
 * UTF-8, may hold any character). Both exclusions are enforced at the publishers'
 * choke points, not here.
 *
 * Pinned against the shared fleet vectors vendored at
 * `src/__tests__/ntfy-header-conformance.json` by `ntfy-header-safety-sweep.test.ts`.
 */
export function toHeaderSafe(value: string): string {
  let out = value;
  for (const [pattern, replacement] of HEADER_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  // CR/LF is a header-injection primitive as well as an encoding problem. Each
  // becomes a space (so "ok\r\nX-Evil: 1" -> "ok  X-Evil: 1"), never dropped —
  // deleting them would silently splice two fields into one token.
  out = out.replace(/[\r\n]/g, ' ');
  // DROP combining marks so NFD-decomposed input folds identically to NFC.
  // Degrading them to '?' turned NFD `café` into `cafe?` — same word, different
  // output, purely by normal form. (ADR-0200 Am.3)
  out = out.replace(/[\u0300-\u036F]/g, '');

  return [...out]
    .map((ch) => {
      if (ch.codePointAt(0)! < 128) return ch;
      const base = [...ch.normalize('NFKD')].filter((c) => c.codePointAt(0)! < 128).join('');
      return base || '?';
    })
    .join('');
}
