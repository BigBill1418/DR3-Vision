// ADR-0019.5 — header-safe coercion for the cron daemons.
//
// A .mjs twin of `src/lib/ntfy-header-safe.ts`, kept because these daemons are
// deliberately dependency-free plain JS that run from the runner stage without a
// TS compile step (see the header of any *-cron.mjs). The two implementations
// are pinned equal by `src/__tests__/ntfy-header-safety-sweep.test.ts`, so they
// cannot drift the way the fleet's four independent copies of this fix did.
//
// Why it matters HERE especially: these daemons publish the app-INDEPENDENT
// backstop pages — the ones that fire when the app is down. A dropped page from
// this layer has nothing behind it.

const HEADER_TRANSLITERATIONS = [
  [/[—–−]/g, '-'], // em / en / minus  → hyphen
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, '...'],
  [/×/g, 'x'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/→/g, '->'],
  [/[    ]/g, ' '], // exotic spaces
  [/•/g, '*'],
];

/**
 * Make a string safe to put in an HTTP header value.
 *
 * WHY THIS EXISTS — the 2026-08-05 dropped page. Header values are ByteStrings
 * (latin-1). Node's undici throws
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
 * This is the fourth re-discovery of this class on the fleet: the bash/Python
 * helpers were patched 2026-05-06, noc-master's Node publisher by ADR-0063
 * (2026-05-22) — whose own open question asked whether the fix should become a
 * shared utility "to prevent a fourth re-discovery". This repo's helper was
 * never patched. See ADR-0019.5.
 *
 * Transliterate first so the operator still gets a readable sentence, then hard
 * replace any residual codepoint > 255 with `?`. The backstop matters more than
 * the table: an unmapped glyph must degrade to a sendable page, never a lost
 * one. Bodies are NOT sanitized — they travel as UTF-8 and may hold anything.
 */
export function toHeaderSafe(value) {
  let out = value;
  for (const [pattern, replacement] of HEADER_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  // eslint-disable-next-line no-control-regex -- stripping CR/LF is header-injection defence
  out = out.replace(/[\r\n]/g, ' ');
  return [...out].map((ch) => (ch.codePointAt(0) > 255 ? '?' : ch)).join('');
}

