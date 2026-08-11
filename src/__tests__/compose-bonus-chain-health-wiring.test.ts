// ADR-0019.4 — compose-wiring guard for the signature-chain health check.
//
// Same lesson as compose-ap-escalation-scan-wiring.test.ts: unit tests inject the
// daemon's env directly, so they cannot catch a compose that never mounts it. A
// missing cron.env or INTERNAL_BASE_URL ships a daemon that POSTs without a
// bearer, gets a 404 from the loopback guard, logs into its own container, and
// reports nothing — a watchdog that does not watch.
//
// That is not hypothetical here. ADR-0092 (2026-08-11) found the stale-claim
// watchdog had been 401ing every fire since it shipped, and the sweep it added
// immediately found /api/internal/idempotency/sweep in the same state. The class
// is "a cron that fails silently forever", and this file is this daemon's share
// of the fix.

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

describe('docker-compose bonus-chain-health wiring (ADR-0019.4)', () => {
  const compose = readFileSync(
    fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)),
    'utf8',
  );
  const block = serviceBlock(compose, 'bonus-chain-health');

  it('runs the chain-health daemon, not some other script', () => {
    expect(block).toContain("command: ['node', 'scripts/bonus-chain-health-cron.mjs']");
    expect(block).toContain('container_name: dr3-vision-bonus-chain-health');
  });

  it('mounts cron.env so INTERNAL_CRON_TOKEN is present — without it every fire 404s', () => {
    expect(block).toContain('/home/bbarnard065/.dr3-vision-secrets/cron.env');
  });

  it('sets INTERNAL_BASE_URL to the app service on the compose network', () => {
    expect(block).toContain('INTERNAL_BASE_URL: http://app:3000');
  });

  it('waits for the app to be healthy before firing', () => {
    expect(block).toContain('condition: service_healthy');
  });

  it('disables the inherited HTTP healthcheck (a cron serves no port)', () => {
    expect(block).toMatch(/healthcheck:\s*\n\s*disable: true/);
  });

  it('restarts unless stopped — a dead watchdog must come back on its own', () => {
    expect(block).toContain('restart: unless-stopped');
  });

  it('does NOT mount ntfy env: the APP publishes the page, this container only schedules', () => {
    expect(block).not.toContain('NTFY_PUBLISHER_TOKEN');
    expect(block).not.toContain('ntfy.env');
  });
});
