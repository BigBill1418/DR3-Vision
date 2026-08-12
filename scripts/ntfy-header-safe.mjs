// ADR-0019.5 / ADR-0093 — header-safe coercion for the cron daemons.
//
// A .mjs twin of `src/lib/ntfy-header-safe.ts`, kept because these daemons are
// deliberately dependency-free plain JS that run from the runner stage without a
// TS compile step (see the header of any *-cron.mjs). The two implementations
// are pinned equal by `src/__tests__/ntfy-header-safety-sweep.test.ts` — on the
// shared fleet vectors, not on an ad-hoc case list — so they cannot drift the
// way the fleet's four independent copies of this fix did.
//
// Why it matters HERE especially: these daemons publish the app-INDEPENDENT
// backstop pages — the ones that fire when the app is down. A dropped page from
// this layer has nothing behind it.
//
// CONTRACT VERSION 3 (ADR-0093; fleet contract noc-master ADR-0200 Am.3). v1
// emitted latin-1 and only degraded codepoints above 255. v2 emits PURE ASCII
// and folds accents. v3 closes two blind spots in v2: combining marks are now
// DROPPED rather than degraded (so NFD-decomposed input folds identically to
// NFC), and characters with no NFKD decomposition but an obvious ASCII
// rendering (ß, °, æ, ø, µ, ½ …) are transliterated instead of becoming '?'.
// See the doc comment on `toHeaderSafe` for why.

const HEADER_TRANSLITERATIONS = [
  [/[‐-―−]/g, '-'], // hyphen / figure / en / em dash, true minus
  [/[‘’‚‛]/g, "'"], // single curly quotes
  [/[“”„‟]/g, '"'], // double curly quotes
  [/…/g, '...'], // ellipsis
  [/×/g, 'x'], // multiplication sign
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/→/g, '->'], // rightwards arrow — DR3 period labels use it
  [/[    ]/g, ' '], // nbsp / figure / thin / narrow spaces
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
 * 8212), so `X-Title` threw — and because the fallback builds the same header,
 * it threw identically on the primary AND the ntfy.sh fallback, in the same
 * millisecond, WITHOUT OPENING A SOCKET. The publish reported `dropped` while
 * the ntfy server was demonstrably healthy. That is how the stranded-period page
 * for Eugene Period 16 was lost.
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
 * raises `UnicodeEncodeError: 'ascii' codec can't encode character 'é'` — the
 * same before-the-socket, kills-both-legs failure the em dash caused here. One
 * fleet, one contract: sanitising to the loosest client's limit means a title
 * that is safe in this repo is a dropped page in the next one.
 *
 * ORDER MATTERS: transliterate → strip CR/LF → drop combining marks → fold
 * accents → degrade. Accented letters fold to their ASCII base via NFKD, so
 * `café renewal for José` becomes `cafe renewal for Jose` and stays readable
 * rather than `caf? for Jos?`. Only characters with no ASCII base (emoji, CJK)
 * become `?` — an unmapped glyph must degrade to a sendable page, never a lost one.
 *
 * COMBINING MARKS ARE DROPPED, NOT DEGRADED (contract v3, ADR-0200 Am.3) — the
 * same word must not sanitize differently by normal form. `café` composed (NFC,
 * U+00E9) folded to `cafe`, but decomposed (NFD, `e` + U+0301) left the mark as
 * a standalone codepoint with no ASCII base, so it degraded to `?` and produced
 * `cafe?`. Callers do not control the normal form of the strings they are handed.
 *
 * Iteration is over CODEPOINTS, not UTF-16 units, so an astral emoji yields one
 * `?` rather than two.
 *
 * NOT sanitized: `Authorization` (a bearer is ASCII by construction; mangling it
 * would turn an encoding bug into an auth bug) and the message BODY (sent as
 * UTF-8). Both exclusions live at the callers' choke points, not here.
 */
export function toHeaderSafe(value) {
  let out = value;
  for (const [pattern, replacement] of HEADER_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  // CR/LF is a header-injection primitive as well as an encoding problem. Each
  // becomes a space (so "ok\r\nX-Evil: 1" -> "ok  X-Evil: 1"), never dropped.
  // eslint-disable-next-line no-control-regex -- stripping CR/LF is header-injection defence
  out = out.replace(/[\r\n]/g, ' ');
  // DROP combining marks so NFD-decomposed input folds identically to NFC.
  // Degrading them to '?' turned NFD `café` into `cafe?` — same word, different
  // output, purely by normal form. (ADR-0200 Am.3)
  out = out.replace(/[\u0300-\u036F]/g, '');

  return [...out]
    .map((ch) => {
      if (ch.codePointAt(0) < 128) return ch;
      const base = [...ch.normalize('NFKD')].filter((c) => c.codePointAt(0) < 128).join('');
      return base || '?';
    })
    .join('');
}
