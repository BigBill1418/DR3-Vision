// ADR-0057 D1/D9 — compose-wiring guard for the mymrc-scrape credential
// transition. The unit tests inject env directly, so they can't catch a compose
// that (a) never mounts the encryption key, (b) still mounts the retired per-site
// creds file, or (c) drops the D9 healthcheck. This reads the real
// docker-compose.yml so the deployed topology can't silently regress (same
// approach as compose-escalation-ntfy-wiring.test.ts).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Extract a single top-level service block: from `  <name>:` up to (not
// including) the next two-space-indented key.
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `service ${name} not found in docker-compose.yml`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : start + 1 + end).join('\n');
}

describe('docker-compose mymrc-scrape credential wiring (ADR-0057 D1/D9)', () => {
  const compose = readFileSync(
    fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)),
    'utf8',
  );
  const block = serviceBlock(compose, 'mymrc-scrape');

  it('mounts mymrc-cred-key.env so the scrape can decrypt the DB-stored login', () => {
    expect(block).toContain('.dr3-vision-secrets/mymrc-cred-key.env');
  });

  it('keeps the key mount fail-soft (required: false) for deploy-before-provision', () => {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('.dr3-vision-secrets/mymrc-cred-key.env'));
    expect(lines.slice(idx, idx + 2).join('\n')).toMatch(/required:\s*false/);
  });

  it('no longer mounts the retired per-site creds file (mymrc.env)', () => {
    expect(block).not.toContain('.dr3-vision-secrets/mymrc.env');
  });

  it('carries no retired per-site MYMRC_{EUGENE,WOODLAND,OR,CA}_* env vars', () => {
    expect(block).not.toMatch(/MYMRC_(EUGENE|WOODLAND|OR|CA)_/);
  });

  it('has the D9 healthcheck that reports unhealthy until creds are configured', () => {
    expect(block).toContain('scripts/mymrc-healthcheck.mjs');
    expect(block).toMatch(/healthcheck:/);
  });

  // End-to-end key path: the app ENCRYPTS on save and the scrape DECRYPTS — both
  // must mount the SAME MYMRC_CRED_KEY file or the round-trip breaks silently.
  it('the app service also mounts mymrc-cred-key.env so writes encrypt with the same key', () => {
    const appBlock = serviceBlock(compose, 'app');
    expect(appBlock).toContain('.dr3-vision-secrets/mymrc-cred-key.env');
    const lines = appBlock.split('\n');
    const idx = lines.findIndex((l) => l.includes('.dr3-vision-secrets/mymrc-cred-key.env'));
    expect(lines.slice(idx, idx + 2).join('\n')).toMatch(/required:\s*false/);
  });
});
