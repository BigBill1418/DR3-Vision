// T-108 — Loki structured logging (ADR-0022 §3).
//
// A single pino logger emitting newline-delimited JSON so Alloy can ship it to
// Loki. Server-side only: pino is listed in next.config `serverExternalPackages`
// (it ships a worker-thread transport that must not be webpack-bundled), so this
// module MUST NOT be imported from edge or client code. Middleware correlates
// requests by setting an `x-request-id` header (edge-safe, no pino) which Node
// route handlers read to build a child logger via `childLogger()`.
//
// Redaction is structural (pino `redact`), not best-effort string scrubbing:
// any of the listed paths is replaced with the literal '[REDACTED]' before the
// line is serialized, so PINs / passwords / auth headers / cookies never reach
// Loki even when an object is logged wholesale. This complements the GlitchTip
// `beforeSend` scrubber in sentry.ts.

import { randomUUID } from 'node:crypto';
import pino, { type LoggerOptions } from 'pino';
import { buildInfo } from '@/lib/build-info';

/**
 * Fields scrubbed from every log line, per ADR-0022 §3. Leading-`*` paths match
 * the field at any nesting depth; `req.headers.cookie` is an exact path. Exported
 * so the contract is assertable in tests and reusable by other scrubbers.
 */
export const REDACT_PATHS = [
  '*.password',
  '*.pin',
  '*.pin_hash',
  '*.authorization',
  'req.headers.cookie',
] as const;

/**
 * The pino options shared by the singleton `log` and any test instance. Kept as
 * a factory so tests can drive the exact production configuration against an
 * in-memory destination instead of stdout.
 */
export function buildLoggerOptions(): LoggerOptions {
  return {
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: {
      service: 'dr3-vision',
      // Real deploy identity (never a bare 'dev' in prod) — the single
      // buildInfo() source (GIT_SHA override, else the next.config-inlined
      // sha from the baked .build-info.json). Before 2026-07-10 this read a
      // never-set env var and stamped version:"dev" on every prod log line.
      version: buildInfo().sha,
      env: process.env['NODE_ENV'],
    },
    // ISO-8601 timestamps (e.g. "2026-06-05T12:34:56.789Z") so Loki/Grafana
    // parse the event time directly rather than an epoch-millis number.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
  };
}

/** Process-wide structured logger. Import this for all server-side logging. */
export const log = pino(buildLoggerOptions());

/** A fresh request-correlation id. UUID v4 from the Node crypto module. */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * A logger bound to a single request. Pass the `x-request-id` value set by
 * middleware so every line for that request carries `request_id` for Loki
 * correlation.
 */
export function childLogger(requestId: string) {
  return log.child({ request_id: requestId });
}
