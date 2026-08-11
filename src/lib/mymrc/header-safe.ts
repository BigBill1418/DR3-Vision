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

/**
 * Transliteration table for the Unicode punctuation these titles actually use.
 * Mirrors ADR-0063 §1's `toHeaderSafe()` in noc-master, plus `→` because DR3
 * period labels are written `2026-07-21→08-03`.
 */
const HEADER_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
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
export function toHeaderSafe(value: string): string {
  let out = value;
  for (const [pattern, replacement] of HEADER_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/[\r\n]/g, ' ');
  return [...out].map((ch) => (ch.codePointAt(0)! > 255 ? '?' : ch)).join('');
}
