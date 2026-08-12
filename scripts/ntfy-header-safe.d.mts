// Type surface for the (JS) shared ntfy header sanitizer, so vitest can import
// it under `allowJs: false` to pin it equal to the TypeScript implementation in
// `src/lib/ntfy-header-safe.ts`. The module is pure — importing it has no side
// effects.

/**
 * Coerce a string into something safe to place in an HTTP header value.
 *
 * Header values are ByteStrings (latin-1); a codepoint above 255 makes undici
 * throw before a socket opens, which silently kills a publish on BOTH the
 * primary and the fallback. Output is PURE ASCII, because httpx — used by other
 * fleet publishers — raises above U+007F where undici tolerates up to U+00FF.
 * Transliterates the Unicode punctuation these titles use, strips CR/LF, DROPS
 * combining marks (so NFD input folds identically to NFC), folds accents via
 * NFKD, then degrades any residual non-ASCII to `?`. Contract v3 — see
 * ADR-0019.5 / ADR-0093 and the implementation's own doc comment.
 */
export function toHeaderSafe(value: string): string;
