// Deploy identity for logs + ntfy alerts. Baked into the image at build time
// (Dockerfile writes .build-info.json from .git); env GIT_SHA wins when set.
// Never "0.1.0" — package.json's scaffold version is not a deploy identity.
import { readFileSync } from 'node:fs';

interface BuildInfo {
  sha: string;
  builtAt: string;
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  let fromFile: Partial<BuildInfo> = {};
  try {
    fromFile = JSON.parse(readFileSync('.build-info.json', 'utf8')) as Partial<BuildInfo>;
  } catch {
    // dev / test — file absent
  }
  cached = {
    sha: process.env['GIT_SHA'] ?? fromFile.sha ?? 'dev',
    builtAt: fromFile.builtAt ?? 'unknown',
  };
  return cached;
}

/** Short form for human-facing strings. */
export function shortSha(): string {
  const s = buildInfo().sha;
  return s === 'dev' || s === 'unknown' ? s : s.slice(0, 7);
}
