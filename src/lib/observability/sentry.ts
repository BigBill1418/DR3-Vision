// GlitchTip (Sentry-compatible) error reporting (ADR-0022 §2).
//
// GlitchTip implements the Sentry ingest API, so the official `@sentry/nextjs`
// SDK works against a GlitchTip DSN. This module centralizes the init options so
// the server, edge, and client config files all share one scrubbing policy.
//
// FAIL-OPEN (SPRINT-2-HANDOFF hard rule #6): if `GLITCHTIP_DSN` is unset, init is
// a clean no-op — the app runs normally with no error reporting. This matches the
// ntfy publisher and MyMRC scrape patterns.
//
// DIVISION OF LABOR with the existing ntfy publisher (src/lib/ntfy.ts):
//   - GlitchTip captures EVERY error (handled + unhandled), all roles, browseable
//     in the fleet UI. tracesSampleRate is 0 — Tempo owns traces (ADR-0022 §1).
//   - ntfy fires only for system-level incidents, only to Bill, mobile-push.
// The two are complementary and gate independently.

import type { BrowserOptions, NodeOptions } from '@sentry/nextjs';

type BeforeSend = NonNullable<NodeOptions['beforeSend']>;
type BeforeBreadcrumb = NonNullable<NodeOptions['beforeBreadcrumb']>;
export type SentryErrorEvent = Parameters<BeforeSend>[0];
export type SentryBreadcrumb = Parameters<BeforeBreadcrumb>[0];

// ─── Scrubbing policy (ADR-0022 Amendment 1) ────────────────────────────────
// ALLOWLISTS, not denylists: anything not named here is removed, so a field the
// SDK adds later (it already adds a capitalised `Referer`) cannot leak by default.

/** Request headers that survive. Compared case-insensitively. */
const KEEP_HEADERS = new Set(['user-agent']);
/** Event contexts that survive (no PII: browser/OS/device model). */
const KEEP_CONTEXTS = new Set(['browser', 'os', 'device']);
/** Breadcrumb `data` keys that survive; URL-bearing ones are scrubbed. */
const KEEP_CRUMB_DATA = new Set(['method', 'status_code', 'url', 'from', 'to']);
const URL_CRUMB_KEYS = new Set(['url', 'from', 'to']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A path segment that is a bearer capability, not an id. Survey tokens are
 * 32-char base64url (src/lib/survey/tokens.ts) and are always replaced after
 * /survey/ and /api/survey/. Elsewhere, any base64url segment of 32+ chars that
 * is not a UUID is treated the same way — record ids (cuid ≈ 25 chars, UUIDs)
 * stay, because they grant nothing on their own (the policy already keeps
 * user.id), and /operator/<site>/<userId> must stay debuggable.
 */
function scrubPath(path: string): string {
  return path
    .replace(/(\/(?:api\/)?survey\/)[^/?#]+/g, '$1[token]')
    .replace(/(^|\/)([A-Za-z0-9_-]{32,})(?=\/|$)/g, (m, lead: string, seg: string) =>
      UUID.test(seg) ? m : `${lead}[token]`,
    );
}

/** Drop query/fragment (can carry names or PIN params) and scrub token segments. */
export function scrubUrl(url: string): string {
  const bare = url.replace(/[?#].*$/, '');
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(bare)?.[0] ?? '';
  return origin + scrubPath(bare.slice(origin.length));
}

/**
 * Best-effort text scrub for free text we cannot drop (exception values, the
 * event message, tag values). ORDER IS LOAD-BEARING: tokens first (URLs, then
 * any bare 32+ char base64url word), then emails, then digit runs — masking
 * digits first would cut a token below 32 chars and leak the rest of it.
 * Digit runs are 4–6 digits in ANY script (\p{Nd}; a PIN is 4) standing alone
 * as a word; UUIDs are set aside first so their hex groups are never masked.
 * Names in free text are NOT caught — code must not put them in thrown messages.
 */
export function scrubText(text: string): string {
  const tokenless = scrubUrlsInText(text).replace(
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    // Bare words need a digit AND a letter, so long error codes such as
    // `throughput_machine_not_configured` survive; a random 32-char base64url
    // token lacks a digit with probability ~(54/64)^32 ≈ 0.4% (accepted residual).
    (w) => (UUID.test(w) || !/\d/.test(w) || !/[A-Za-z]/.test(w) ? w : '[token]'),
  );
  // Split around UUIDs (capturing group ⇒ odd indexes are the UUIDs themselves).
  return tokenless
    .split(UUID_IN_TEXT)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
            .replace(/(?<![\p{L}\p{N}])\p{Nd}{4,6}(?![\p{L}\p{N}])/gu, '[digits]'),
    )
    .join('');
}

const UUID_IN_TEXT = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function scrubUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+|\/(?:api\/)?survey\/[^\s"'<>)/?#]+/g, (u) =>
    u.startsWith('/') ? scrubPath(u) : scrubUrl(u),
  );
}

/**
 * Breadcrumb filter (browser + server). UI breadcrumbs are dropped outright: a
 * keypad tap records the tapped element, so a PIN entry would leave its digits
 * in order in the trail. Console breadcrumbs are dropped because log lines can
 * carry operator names. Every other crumb loses its `message` and keeps only the
 * allowlisted `data` keys, with URLs scrubbed.
 */
export function scrubBreadcrumb(crumb: SentryBreadcrumb): SentryBreadcrumb | null {
  const category = crumb.category ?? '';
  if (category.startsWith('ui.') || category === 'console') return null;
  delete crumb.message;
  if (crumb.data) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(crumb.data)) {
      if (!KEEP_CRUMB_DATA.has(key)) continue;
      data[key] = URL_CRUMB_KEYS.has(key) && typeof value === 'string' ? scrubUrl(value) : value;
    }
    crumb.data = data;
  }
  return crumb;
}

/**
 * The one scrubbing policy for every runtime (CLAUDE.md hard rule #8, ADR-0007,
 * ADR-0022 Amendment 1). GlitchTip must never receive PIN digits, operator names,
 * request bodies or capability tokens.
 */
export const scrubEvent = ((event: SentryErrorEvent): SentryErrorEvent | null => {
  if (event.request) {
    const { headers, url } = event.request;
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    delete event.request.env;
    if (url) event.request.url = scrubUrl(url);
    if (headers) {
      event.request.headers = Object.fromEntries(
        Object.entries(headers).filter(([k]) => KEEP_HEADERS.has(k.toLowerCase())),
      );
    }
  }
  // Only the opaque id survives: no username, email or IP.
  if (event.user) {
    if (event.user.id === undefined) delete event.user;
    else event.user = { id: event.user.id };
  }
  // `extra` carries arbitrary payloads (the SDK's wrap() puts call arguments in
  // extra.arguments) — never sent.
  delete event.extra;
  if (event.contexts) {
    event.contexts = Object.fromEntries(
      Object.entries(event.contexts).filter(([k]) => KEEP_CONTEXTS.has(k)),
    );
  }
  if (event.tags) {
    for (const [k, v] of Object.entries(event.tags)) {
      if (typeof v === 'string') event.tags[k] = scrubText(v);
      // A number-typed tag (e.g. a PIN guess) is masked like text; other numbers stay numbers.
      else if (typeof v === 'number' && scrubText(String(v)) !== String(v))
        event.tags[k] = '[digits]';
    }
  }
  if (event.transaction) event.transaction = scrubPath(event.transaction);
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry) {
    if (event.logentry.message) event.logentry.message = scrubText(event.logentry.message);
    delete event.logentry.params;
  }
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.abs_path) frame.abs_path = scrubUrl(frame.abs_path);
      if (frame.filename) frame.filename = scrubUrl(frame.filename);
      delete frame.vars;
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((b) => scrubBreadcrumb(b) ?? []);
  }
  return event;
}) satisfies BeforeSend;

/**
 * Per-tab volume cap (browser). A crash loop on four tablets must not flood
 * GlitchTip: at most `max` events per sliding `windowMs`; the rest are dropped and
 * counted, and the count rides the next accepted event as tag `dropped_by_limit`.
 * Module scope = one tab; a page reload starts a fresh window, so the GlitchTip
 * project rate limit is the backstop.
 */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const sent: number[] = [];
  let dropped = 0;
  return (event: SentryErrorEvent): SentryErrorEvent | null => {
    const t = now();
    while (sent.length && t - sent[0]! >= windowMs) sent.shift();
    if (sent.length >= max) {
      dropped += 1;
      return null;
    }
    sent.push(t);
    if (dropped) {
      event.tags = { ...event.tags, dropped_by_limit: String(dropped) };
      dropped = 0;
    }
    return event;
  };
}

export const BROWSER_MAX_EVENTS_PER_MINUTE = 10;

/**
 * Browser `Sentry.init` options (src/instrumentation-client.ts). The DSN is
 * passed in because Next inlines `process.env.NEXT_PUBLIC_GLITCHTIP_DSN` only
 * where that literal appears; it is baked at image BUILD time and must name the
 * PUBLIC host errors.barnardhq.com (ADR-0022 Amendment 1).
 */
export function browserInitOptions(dsn: string | undefined): BrowserOptions | null {
  if (!dsn) return null;
  const limit = createRateLimiter(BROWSER_MAX_EVENTS_PER_MINUTE, 60_000);
  return {
    dsn,
    environment: process.env.NODE_ENV,
    release: process.env.DR3_BUILD_SHA ?? 'dev',
    // Every error, once: the SDK's default Dedupe integration drops an identical
    // consecutive event, and the limiter caps volume. Traces are Tempo's job.
    sampleRate: 1,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Scrub FIRST so the limiter never holds an unscrubbed event.
    beforeSend: (event) => {
      const clean = scrubEvent(event);
      return clean && limit(clean);
    },
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

/**
 * Shared server/edge `Sentry.init` options. Returns `null` when no DSN is
 * configured so callers can no-op cleanly (fail-open).
 */
export function glitchTipInitOptions(): NodeOptions | null {
  const dsn = process.env['GLITCHTIP_DSN'];
  if (!dsn) return null;

  return {
    dsn,
    environment: process.env.NODE_ENV,
    release: process.env['GIT_SHA'] ?? 'dev',
    // Tempo handles traces (ADR-0022 §1); GlitchTip is errors-only.
    tracesSampleRate: 0,
    // Sentry 10 ships its own OpenTelemetry setup. We run our own NodeSDK
    // (instrumentation.ts) and export to Tempo, so disable Sentry's to avoid a
    // duplicate global TracerProvider registration.
    skipOpenTelemetrySetup: true,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
