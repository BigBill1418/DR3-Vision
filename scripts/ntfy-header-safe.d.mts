// Type surface for the (JS) shared ntfy header sanitizer, so vitest can import
// it under `allowJs: false` to pin it equal to the TypeScript implementation in
// `src/lib/ntfy-header-safe.ts`. The module is pure — importing it has no side
// effects.

/**
 * Coerce a string into something safe to place in an HTTP header value.
 *
 * Header values are ByteStrings (latin-1); a codepoint above 255 makes undici
 * throw before a socket opens, which silently kills a publish on BOTH the
 * primary and the fallback. Transliterates the Unicode punctuation these titles
 * use, then hard-replaces any residual codepoint > 255 with `?`. See ADR-0019.5.
 */
export function toHeaderSafe(value: string): string;
