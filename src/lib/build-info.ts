// Deploy identity for logs + ntfy alerts. next.config.js reads the baked
// .build-info.json at BUILD time and inlines it via env — this module is pure
// env reads: edge-safe, webpack-safe, no runtime fs. GIT_SHA env wins when set.
export function buildInfo(): { sha: string; builtAt: string } {
  // DOTTED access is required here: next.config's env inlining (DefinePlugin)
  // rewrites only `process.env.X` — bracket access silently misses the inline
  // and reads an env var that never exists at runtime (the pre-2026-07-10 bug
  // that stamped version:"dev" on every prod log/trace/boot alert). Legalized
  // under noPropertyAccessFromIndexSignature by src/types/env.d.ts.
  return {
    sha: process.env.GIT_SHA ?? process.env.DR3_BUILD_SHA ?? 'dev',
    builtAt: process.env.DR3_BUILD_AT ?? 'unknown',
  };
}

/** Short form for human-facing strings. */
export function shortSha(): string {
  const s = buildInfo().sha;
  return s === 'dev' || s === 'unknown' ? s : s.slice(0, 7);
}
