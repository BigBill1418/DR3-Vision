// ADR-0066 §1.5 — compose-wiring guard for the escalation scanner.
//
// Same lesson as compose-escalation-ntfy-wiring.test.ts: unit tests inject the
// daemon's env directly, so they cannot catch a compose that never mounts it. The
// scanner reaches the app over the compose network with a bearer, and a missing
// cron.env or INTERNAL_BASE_URL ships a daemon that logs failures into the void
// while the second-approval backlog ages unescalated — the outage's exact shape.
//
// It also pins the ntfy NON-mount: staff are never paged (hard rule #5), and the
// system-level pages this feature raises are published by the `app` container.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** Everything from `  <name>:` up to (not including) the next two-space key. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `service ${name} not found in docker-compose.yml`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : start + 1 + end).join('\n');
}

describe('docker-compose ap-escalation-scan wiring (ADR-0066 §1.5)', () => {
  const compose = readFileSync(
    fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)),
    'utf8',
  );
  const block = serviceBlock(compose, 'ap-escalation-scan');

  it('runs the scanner daemon under an unless-stopped restart policy', () => {
    expect(block).toContain("command: ['node', 'scripts/ap-escalation-scan.mjs']");
    expect(block).toContain('restart: unless-stopped');
    expect(block).toContain('init: true');
  });

  it('mounts cron.env for the INTERNAL_CRON_TOKEN bearer and targets the app service', () => {
    expect(block).toContain('.dr3-vision-secrets/cron.env');
    expect(block).toContain('INTERNAL_BASE_URL: http://app:3000');
  });

  it('disables the inherited HTTP healthcheck (this is a cron host, not the web app)', () => {
    expect(block).toMatch(/healthcheck:\s*\n\s*disable: true/);
  });

  it('declares resource ceilings', () => {
    expect(block).toContain('mem_limit:');
    expect(block).toContain('pids_limit:');
  });

  it('does NOT mount ntfy.env — staff are never paged from this daemon', () => {
    // Strip comments first: the block deliberately EXPLAINS the non-mount in prose,
    // so a naive substring check would match its own rationale.
    const directives = block
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(directives).not.toContain('ntfy.env');
  });

  it('is not profile-gated — the AP module is live at both sites', () => {
    expect(block).not.toContain('profiles:');
  });
});
