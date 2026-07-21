// Audit P1-4 (post-integration) — compose-wiring guard for the app-INDEPENDENT
// escalation backstop.
//
// The daemon's fire-failure page (`scripts/bonus-escalation-check.mjs`
// `publishFireFailure`) authenticates to the primary ntfy server with
// NTFY_PUBLISHER_TOKEN, which reaches the container only via the `ntfy.env`
// env_file. The unit tests inject that var directly, so they can't catch a
// compose that never mounts it — exactly how the backstop shipped inert. This
// test reads the real docker-compose.yml and asserts the escalation service
// still mounts ntfy.env, so the deployed topology can't silently regress.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Extract a single top-level service block from the compose file: everything
// from `  <name>:` up to (not including) the next two-space-indented key.
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `service ${name} not found in docker-compose.yml`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : start + 1 + end).join('\n');
}

describe('docker-compose bonus-escalation-check ntfy wiring (P1-4 backstop)', () => {
  const compose = readFileSync(
    fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)),
    'utf8',
  );

  it('mounts ntfy.env so the app-independent fire-failure page has a publisher token', () => {
    const block = serviceBlock(compose, 'bonus-escalation-check');
    expect(block).toContain('.dr3-vision-secrets/ntfy.env');
  });

  it('keeps the ntfy mount fail-soft (required: false), matching the app + eod contract', () => {
    const block = serviceBlock(compose, 'bonus-escalation-check');
    const ntfyLineIdx = block
      .split('\n')
      .findIndex((l) => l.includes('.dr3-vision-secrets/ntfy.env'));
    const following = block.split('\n').slice(ntfyLineIdx, ntfyLineIdx + 2).join('\n');
    expect(following).toMatch(/required:\s*false/);
  });
});
