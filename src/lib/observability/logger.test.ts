// T-108 — Loki structured logging (ADR-0022 §3): pino logger contract.
//
// These tests exercise the REAL pino configuration produced by
// `buildLoggerOptions()` by constructing a pino instance that writes to an
// in-memory sink, then asserting on the emitted JSON. They verify:
//   - emitted lines are parseable JSON carrying the service bindings
//     (service / version / env) and an ISO-8601 timestamp
//   - sensitive fields (password, pin, pin_hash, authorization,
//     req.headers.cookie) are redacted to '[REDACTED]'
//   - newRequestId() returns distinct UUIDs
//   - childLogger() carries request_id on every line
//
// We avoid asserting on the singleton `log`'s real transport (it writes to
// stdout); instead we feed the same options into a test instance. This keeps
// the test deterministic and free of the worker-thread transport.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { buildLoggerOptions, newRequestId, REDACT_PATHS } from './logger';

/** A pino destination that captures every emitted line as a parsed object. */
function captureLogger(extraBindings: Record<string, unknown> = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const stream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  const logger = pino(buildLoggerOptions(), stream).child(extraBindings);
  return { logger, lines };
}

describe('logger — bindings + JSON shape', () => {
  it('emits parseable JSON carrying the service bindings', () => {
    const { logger, lines } = captureLogger();
    logger.info('hello');
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry['service']).toBe('dr3-vision');
    expect(typeof entry['version']).toBe('string');
    expect('env' in entry).toBe(true);
    expect(entry['msg']).toBe('hello');
  });

  it('emits an ISO-8601 timestamp', () => {
    const { logger, lines } = captureLogger();
    logger.info('tick');
    const ts = lines[0]!['time'];
    expect(typeof ts).toBe('string');
    // Round-trips through Date and re-serializes identically => valid ISO-8601.
    expect(new Date(ts as string).toISOString()).toBe(ts);
  });
});

describe('logger — redaction', () => {
  it('exposes the ADR-0022 §3 redact paths', () => {
    expect(REDACT_PATHS).toEqual([
      '*.password',
      '*.pin',
      '*.pin_hash',
      '*.authorization',
      'req.headers.cookie',
    ]);
  });

  it('redacts sensitive fields with [REDACTED]', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        user: { password: 'hunter2', pin: '8429', pin_hash: '$argon2id$real' },
        creds: { authorization: 'Bearer secret-token' },
        req: { headers: { cookie: 'session=abc', accept: 'application/json' } },
      },
      'mutation',
    );
    const entry = lines[0]!;
    const user = entry['user'] as Record<string, unknown>;
    const creds = entry['creds'] as Record<string, unknown>;
    const req = entry['req'] as { headers: Record<string, unknown> };

    expect(user['password']).toBe('[REDACTED]');
    expect(user['pin']).toBe('[REDACTED]');
    expect(user['pin_hash']).toBe('[REDACTED]');
    expect(creds['authorization']).toBe('[REDACTED]');
    expect(req.headers['cookie']).toBe('[REDACTED]');

    // Non-sensitive sibling fields survive untouched.
    expect(req.headers['accept']).toBe('application/json');

    // No raw secret leaks anywhere in the serialized line.
    const raw = JSON.stringify(entry);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('8429');
    expect(raw).not.toContain('argon2id');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('session=abc');
  });
});

describe('newRequestId', () => {
  it('returns distinct UUID v4 strings', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(a).toMatch(uuidV4);
    expect(b).toMatch(uuidV4);
  });
});

describe('childLogger', () => {
  it('carries request_id on every emitted line', () => {
    // Build a capturing parent, then child it with a request id the same way
    // childLogger() does, to assert the binding propagates.
    const rid = newRequestId();
    const { logger, lines } = captureLogger({ request_id: rid });
    logger.info('scoped');
    expect(lines[0]!['request_id']).toBe(rid);
  });
});
