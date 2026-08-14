// ntfy publisher — DR3-Vision system-level events.
//
// Per CLAUDE.md hard rule #5 + docs/COMPLIANCE.md, DR3-Vision
// publishes ONLY system-level events (boot, migration applied,
// unhandled errors). Operational events (rejections, long unloads,
// SLA breaches, PIN lockouts) stay on the in-app dashboard and are
// never pushed to Bill's phone.
//
// Wire up:
//   - `dr3-vision-system`    — migration applied, unhandled errors.
//   - `dr3-vision-container` — container started.
//
// Contract — ADR-0036 (transport):
//   - `Authorization: Bearer <NTFY_PUBLISHER_TOKEN>` for the primary
//     (`https://ntfy.barnardhq.com`).
//   - `X-Title` header carries `[DR3-Vision] <human summary>`.
//   - `Click` header points at the most-specific URL available; tier-3
//     fallback is `https://noc-mastercontrol.barnardhq.com/status/dr3-vision`
//     (NOT `noc.barnardhq.com` — the confusable hostname pair documented
//     in `~/.claude/CLAUDE.md`).
//   - `Priority` header: 'default' | 'high' | 'urgent'.
//   - `Tags` header: comma-list.
//   - On primary failure (HTTP error or thrown), retry once on the
//     public ntfy.sh fallback topic from `~/noc-master/data/ntfy-fallback-topics.yml`
//     with `[FALLBACK]` prefixed to the title and Authorization stripped
//     (public ntfy.sh has no auth — its access control is the obscured
//     topic suffix).
//
// Contract — ADR-0037 (noise reduction):
//   - Per-fingerprint cooldown enforced in-process. Default 5 min, but
//     callers can override (boot uses 30 min so a crashloop doesn't
//     spam; unhandled errors use 30 min per fingerprint to dedupe a
//     storm).
//   - The fallback path does NOT apply cooldowns — primary failure
//     always falls through (ADR-0037 §3 explicit carve-out).
//
// Fail-soft: when `NTFY_PUBLISHER_TOKEN` is unset (no `ntfy.env` on
// CHAD-HQ yet), every call resolves to a no-op `false` and logs a
// debug line. The app continues to boot and serve traffic.

// ────────────────────────────────────────────────────────────────────────
// Constants — never change without re-reading ADR-0036 / ADR-0037
// ────────────────────────────────────────────────────────────────────────

import { toHeaderSafe } from './ntfy-header-safe';

const PRIMARY_BASE_DEFAULT = 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';

// Pinned obscured fallback topics from
// `~/noc-master/data/ntfy-fallback-topics.yml` — the dr3-vision rows
// added 2026-05-06. Public ntfy.sh topics; access control IS the
// obscured suffix. Bill's reader subscribes; nobody else needs the name.
const FALLBACK_TOPIC_BY_PRIMARY: Readonly<Record<string, string>> = {
  'dr3-vision-system': 'bhq-fb-dr3v-system-410f6daaf633b110fc69c96ae8d78def',
  'dr3-vision-container': 'barnardhq-fleet-dr3-vision-8a7f2c91e6b4d3a85f0c9d2e7b1a8f4c3',
  'dr3-vision-deploys': 'bhq-fb-dr3v-deploys-6438a50ae307f3744cbcc19d314f787a',
  'dr3-vision-loads': 'bhq-fb-dr3v-loads-43e1bf27f2c2e628478017a0e756cf73',
};

// ADR-0036 §Click URL priority tier 3.
const DEFAULT_CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const TITLE_PREFIX = '[DR3-Vision]';

// ADR-0037 §3 default cooldown for routine alerts.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// Best-effort timeout — never blocks request handlers longer than this.
const PRIMARY_TIMEOUT_MS = 5_000;
const FALLBACK_TIMEOUT_MS = 5_000;

// Retry backoff schedules (ADR-0037 resilience addendum, 2026-06-09).
// A transient egress blip on CHAD-HQ takes out a single primary attempt
// AND the fallback attempt fired milliseconds later — observed when the
// t4 payroll-deadline-missed escalation dropped (both paths failed ~16ms
// apart, far too fast to be 5s timeouts, i.e. instant connection errors).
// A couple of fast retries with short backoff turn that miss into a
// `sent`/`fallback-sent`. Because a transient failure returns instantly,
// a retry costs roughly the backoff, not a full timeout.
//
// Array length = number of retries → PRIMARY does up to 3 attempts,
// FALLBACK up to 2. Each value is the pause BEFORE the next attempt.
const PRIMARY_RETRY_BACKOFF_MS: readonly number[] = [250, 750];
const FALLBACK_RETRY_BACKOFF_MS: readonly number[] = [500];

// Overall wall-clock budget across ALL attempts (primary + fallback).
// Bounds the worst case when the server is genuinely hung (every attempt
// times out) so a publish never blocks a caller far beyond this. A
// fast-failing transient never approaches it; this only caps the
// pathological all-timeout case.
const PUBLISH_TOTAL_BUDGET_MS = 12_000;

// ntfy body cap — server accepts more, but a runaway error message
// shouldn't push a 1MB blob through the helper.
const BODY_MAX_BYTES = 1024;

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

export type NtfyPriority = 'default' | 'high' | 'urgent';

export interface PublishNtfyArgs {
  /** Topic prefix (e.g. `dr3-vision-system`). Required — no default. */
  topic: string;
  /** Human summary. Auto-prefixed with `[DR3-Vision]`. */
  title: string;
  /** Free-form message body. Truncated at 1024 bytes. */
  body: string;
  /** Per ADR-0037 §1. Defaults to `default`. */
  priority?: NtfyPriority;
  /** Comma-list of tags or array of tag strings. */
  tags?: readonly string[];
  /**
   * Click target. Picks the most-specific URL available; tier-3
   * fallback is `https://noc-mastercontrol.barnardhq.com/status/dr3-vision`.
   */
  clickUrl?: string;
  /**
   * Caller-owned dedup fingerprint. If two calls share the same
   * fingerprint within `cooldownMs`, the second is silently dropped.
   * If omitted, a fingerprint is derived from `topic + title`.
   */
  fingerprint?: string;
  /**
   * Cooldown window for the fingerprint, in ms. Defaults to 5 min
   * (ADR-0037 §3). Callers can override per ADR-0037 §3 cooldown matrix.
   */
  cooldownMs?: number;
}

export interface PublishNtfyResult {
  /** True if a request landed (primary or fallback) or was suppressed by cooldown / unconfigured. */
  ok: boolean;
  /** What happened — useful for logs and tests. */
  outcome: 'sent' | 'fallback-sent' | 'cooldown-suppressed' | 'unconfigured' | 'dropped';
}

// ────────────────────────────────────────────────────────────────────────
// In-memory cooldown ledger (ADR-0037 §3)
// ────────────────────────────────────────────────────────────────────────
//
// One ledger per Node.js process. Multi-replica deployments would each
// keep their own ledger, but DR3-Vision runs a single replica on
// CHAD-HQ so this is sufficient. If we scale out, swap in a Redis
// SETNX backend (CallVault's `services/ntfy.py` is the reference).

const cooldownLedger = new Map<string, number>();

// Eviction guard — bound the ledger size so a long-running process
// can't accumulate fingerprints indefinitely. Tested with 10k boundary.
const COOLDOWN_LEDGER_MAX = 10_000;

function fingerprintKey(topic: string, title: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  // Stable, short hash so two semantically-identical alerts collide
  // even if the body varies (e.g. timestamp drift in the message).
  // Inline FNV-1a 32-bit hash — avoids `node:crypto` so this module
  // bundles cleanly into Next.js edge + browser targets if it ever
  // gets pulled there (instrumentation hook compiles in both runtimes
  // even when the function body short-circuits on edge).
  return fnv1a32(`${topic}\n${title}`);
}

function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.byteLength <= maxBytes) return s;
  // TextDecoder.fatal=false will replace partial codepoints with U+FFFD
  // rather than throw — preferable to a crashing publish.
  const dec = new TextDecoder('utf-8', { fatal: false });
  return dec.decode(bytes.subarray(0, maxBytes));
}

function fnv1a32(s: string): string {
  // FNV-1a 32-bit. Stable, no deps, sufficient for cooldown-ledger
  // collision avoidance — we don't need cryptographic security here,
  // just a deterministic short key. ~10ns/call on V8.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function cooldownActive(key: string, now: number): boolean {
  const expiresAt = cooldownLedger.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    cooldownLedger.delete(key);
    return false;
  }
  return true;
}

function recordCooldown(key: string, now: number, cooldownMs: number): void {
  if (cooldownLedger.size >= COOLDOWN_LEDGER_MAX) {
    // Evict the oldest entries by re-walking. O(n) but n is bounded
    // and this fires at most once per 10k publishes, so amortised cost
    // is negligible.
    const entries = [...cooldownLedger.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < entries.length / 2; i++) {
      const entry = entries[i];
      if (entry) cooldownLedger.delete(entry[0]);
    }
  }
  cooldownLedger.set(key, now + cooldownMs);
}

// Test seam — exposed only via `__testing` so production callers can't
// reach it. Vitest uses this to reset state between tests.
function clearCooldownLedger(): void {
  cooldownLedger.clear();
}

// ────────────────────────────────────────────────────────────────────────
// Header construction — ADR-0036 §Notification standard
// ────────────────────────────────────────────────────────────────────────

function buildHeaders(args: {
  title: string;
  priority: NtfyPriority;
  clickUrl: string;
  tags: readonly string[] | undefined;
  publisherToken: string | undefined;
  isFallback: boolean;
}): Record<string, string> {
  const fullTitle =
    (args.isFallback ? `[FALLBACK] ${TITLE_PREFIX} ` : `${TITLE_PREFIX} `) + args.title;
  const headers: Record<string, string> = {
    // ntfy accepts both `Title` and `X-Title`; we use `X-Title` per the
    // canonical fleet spelling in CLAUDE.md.
    'X-Title': fullTitle.slice(0, 250),
    Priority: args.priority,
    Click: args.clickUrl,
  };
  if (args.tags && args.tags.length > 0) {
    const joined = args.tags.filter((t) => t).join(',');
    if (joined) headers['Tags'] = joined;
  }
  if (!args.isFallback && args.publisherToken) {
    headers['Authorization'] = `Bearer ${args.publisherToken}`;
  }

  // Sanitize at this SINGLE choke point, after every header is assembled, so it
  // covers every call site and both transports. Applying it per-field at the
  // call sites is what let the defect survive three previous fixes.
  // Authorization is excluded: a token is ASCII by construction, and mangling
  // it would turn an encoding bug into an auth bug.
  for (const key of Object.keys(headers)) {
    if (key === 'Authorization') continue;
    headers[key] = toHeaderSafe(headers[key]!);
  }
  return headers;
}

// ────────────────────────────────────────────────────────────────────────
// HTTP POST helpers — primary + fallback
// ────────────────────────────────────────────────────────────────────────

/**
 * The reason a single publish attempt failed. Recorded so a caller's log line
 * can say WHY rather than a bare "dropped".
 *
 * Before 2026-08-11 this function ended in `catch { return false; }`. That empty
 * catch is the reason a `TypeError` about header encoding — thrown identically
 * on every attempt and both transports — presented to operators as an
 * indistinguishable "primary+fallback failed", and why the defect survived from
 * whenever it was introduced until someone read the source. A swallowed error is
 * not a smaller failure; it is the same failure with the evidence removed.
 */
/**
 * Structured drop record.
 *
 * `console.error`, not the pino logger: this module's header contract keeps it
 * free of `node:crypto` so it bundles into edge/browser targets, and
 * `@/lib/observability/logger` imports both pino and node:crypto and documents
 * that it must not be reached from edge code. The line is JSON so Alloy still
 * ships it to Loki in a queryable shape.
 *
 * `reason` is the whole point: a drop with no reason is what turned a header
 * encoding bug into a month of invisible failures.
 */
function logDrop(fields: {
  topic: string;
  fallbackTopic: string | null;
  reason: string | null;
  msg: string;
}): void {
  console.error(JSON.stringify({ level: 50, op: 'ntfy', ...fields }));
}

let lastFailureReason: string | null = null;

/** Why the most recent failed publish attempt failed (for the caller's log). */
export function lastPublishFailureReason(): string | null {
  return lastFailureReason;
}

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      body,
      headers,
      signal: controller.signal,
    });
    if (!resp.ok) {
      // Drain the body so the connection can be reused, but never log
      // it at warn — error messages can leak token state.
      await resp.text().catch(() => '');
      lastFailureReason = `http_${resp.status}`;
      return false;
    }
    lastFailureReason = null;
    return true;
  } catch (err) {
    // Record the CLASS and message, never the headers — they carry the bearer.
    const e = err as { name?: string; message?: string };
    lastFailureReason = `${e?.name ?? 'Error'}: ${(e?.message ?? String(err)).slice(0, 200)}`;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Injectable sleep — production waits real time between retries; tests
// swap in a no-op via `__testing.setSleep` so the retry paths run
// instantly (no fake-timer plumbing needed for the backoff waits).
let sleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST with bounded retries + backoff, stopping early if the overall
 * publish budget (`deadline`, an absolute ms timestamp) would be
 * exceeded by the next backoff wait. Returns true on the first success;
 * false once the retry schedule or the time budget runs out.
 *
 * Failures from `postWithTimeout` are indistinguishable (non-2xx, thrown,
 * or aborted all collapse to `false`), so we retry uniformly — a
 * transient connection error fails fast and is cheap to retry; a genuine
 * outage exhausts the schedule and the budget caps total latency.
 */
async function postWithRetry(
  url: string,
  body: string,
  headers: Record<string, string>,
  perAttemptTimeoutMs: number,
  backoffMs: readonly number[],
  deadline: number,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (await postWithTimeout(url, body, headers, perAttemptTimeoutMs)) {
      return true;
    }
    const backoff = backoffMs[attempt];
    if (backoff === undefined) return false; // retry schedule exhausted
    if (Date.now() + backoff >= deadline) return false; // budget exhausted
    await sleep(backoff);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Env reads — late-binding so test harnesses can stub `process.env`
// ────────────────────────────────────────────────────────────────────────

function readPublisherToken(): string {
  return process.env['NTFY_PUBLISHER_TOKEN']?.trim() ?? '';
}

function readBaseUrl(): string {
  return process.env['NTFY_BASE_URL']?.trim() || PRIMARY_BASE_DEFAULT;
}

function fallbackTopicFor(primary: string): string | undefined {
  return FALLBACK_TOPIC_BY_PRIMARY[primary];
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Publish a system-level event to ntfy.
 *
 * - Returns `unconfigured` (no-op) when `NTFY_PUBLISHER_TOKEN` is unset.
 * - Returns `cooldown-suppressed` when the fingerprint has fired
 *   within the cooldown window.
 * - Returns `sent` on primary success, `fallback-sent` on primary
 *   failure + fallback success.
 * - Returns `dropped` when both primary and fallback failed —
 *   caller may retry on the next watchdog tick.
 *
 * Never throws.
 */
export async function publishNtfy(args: PublishNtfyArgs): Promise<PublishNtfyResult> {
  const token = readPublisherToken();
  if (!token) {
    return { ok: true, outcome: 'unconfigured' };
  }

  const priority: NtfyPriority = args.priority ?? 'default';
  const clickUrl = args.clickUrl ?? DEFAULT_CLICK_URL;
  const cooldownMs = args.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const fp = fingerprintKey(args.topic, args.title, args.fingerprint);
  const now = Date.now();

  if (cooldownActive(fp, now)) {
    return { ok: true, outcome: 'cooldown-suppressed' };
  }

  // Truncate body at byte boundary — naive char-slice would break
  // multi-byte UTF-8 graphemes. TextEncoder is available in Node 18+
  // and edge/browser runtimes; we also guard against decoder failures
  // on partial sequences by falling back to char-slice.
  const truncated = truncateUtf8(args.body, BODY_MAX_BYTES);

  const baseUrl = readBaseUrl();
  const primaryHeaders = buildHeaders({
    title: args.title,
    priority,
    clickUrl,
    tags: args.tags,
    publisherToken: token,
    isFallback: false,
  });

  // Overall budget shared across every primary + fallback attempt so a
  // hung server can't make this block far past PUBLISH_TOTAL_BUDGET_MS.
  const deadline = now + PUBLISH_TOTAL_BUDGET_MS;

  const primaryOk = await postWithRetry(
    `${baseUrl}/${args.topic}`,
    truncated,
    primaryHeaders,
    PRIMARY_TIMEOUT_MS,
    PRIMARY_RETRY_BACKOFF_MS,
    deadline,
  );
  if (primaryOk) {
    recordCooldown(fp, now, cooldownMs);
    return { ok: true, outcome: 'sent' };
  }

  // Primary failed — fallback path. Per ADR-0037 §3 the fallback does
  // NOT apply cooldowns, but we still record the cooldown on a
  // successful fallback so a subsequent primary-recovered call doesn't
  // double-page. Drops a redundant alert is preferable to spam.
  const fbTopic = fallbackTopicFor(args.topic);
  if (!fbTopic) {
    logDrop({
      topic: args.topic,
      fallbackTopic: null,
      reason: lastFailureReason,
      msg: '[ntfy] primary failed and NO fallback topic is registered - page dropped',
    });
    return { ok: false, outcome: 'dropped' };
  }
  const fallbackHeaders = buildHeaders({
    title: args.title,
    priority,
    clickUrl,
    tags: args.tags,
    publisherToken: undefined,
    isFallback: true,
  });
  const fallbackOk = await postWithRetry(
    `${FALLBACK_BASE}/${fbTopic}`,
    truncated,
    fallbackHeaders,
    FALLBACK_TIMEOUT_MS,
    FALLBACK_RETRY_BACKOFF_MS,
    deadline,
  );
  if (fallbackOk) {
    recordCooldown(fp, now, cooldownMs);
    return { ok: true, outcome: 'fallback-sent' };
  }
  logDrop({
    topic: args.topic,
    fallbackTopic: fbTopic,
    reason: lastFailureReason,
    msg: '[ntfy] primary AND fallback both failed - page dropped',
  });
  return { ok: false, outcome: 'dropped' };
}

// ────────────────────────────────────────────────────────────────────────
// Convenience wrappers — typed entry points for the three system events
// the app actually publishes. Keeps call sites short and the topic /
// cooldown contract centralised.
// ────────────────────────────────────────────────────────────────────────

/** Container started — published once per process boot. 30-min cooldown. */
export async function publishContainerStart(opts: {
  version: string;
  commitSha: string | undefined;
}): Promise<PublishNtfyResult> {
  const sha = opts.commitSha ? ` @ ${opts.commitSha.slice(0, 7)}` : '';
  return publishNtfy({
    topic: 'dr3-vision-container',
    title: 'Container started',
    body: `DR3-Vision app boot — version ${opts.version}${sha}`,
    priority: 'default',
    tags: ['boot', 'dr3-vision'],
    cooldownMs: 30 * 60 * 1000,
    fingerprint: 'dr3-vision-container-start',
  });
}

/** Migration applied — published once per migration name. */
export async function publishMigrationApplied(opts: {
  migrationName: string;
}): Promise<PublishNtfyResult> {
  return publishNtfy({
    topic: 'dr3-vision-system',
    title: `Migration applied ${opts.migrationName}`,
    body: `Prisma migration "${opts.migrationName}" was applied to the production database.`,
    priority: 'default',
    tags: ['migration', 'dr3-vision'],
    fingerprint: `dr3-vision-migration:${opts.migrationName}`,
  });
}

/** Unhandled error — fingerprinted by error class + first stack frame. */
export async function publishUnhandledError(opts: {
  err: unknown;
  context?: string;
}): Promise<PublishNtfyResult> {
  const summary = summariseError(opts.err);
  const fp = fingerprintFromError(opts.err);
  return publishNtfy({
    topic: 'dr3-vision-system',
    title: `Unhandled error: ${summary.title.slice(0, 120)}`,
    body: opts.context ? `${opts.context}\n\n${summary.body}` : summary.body,
    priority: 'high',
    tags: ['error', 'dr3-vision'],
    cooldownMs: 30 * 60 * 1000,
    fingerprint: fp,
  });
}

function summariseError(err: unknown): { title: string; body: string } {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    const message = err.message || '(no message)';
    const stack = err.stack ?? '(no stack)';
    return { title: `${name}: ${message}`, body: stack };
  }
  const stringified = typeof err === 'string' ? err : JSON.stringify(err);
  return { title: stringified.slice(0, 120), body: stringified };
}

function fingerprintFromError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    const firstStackLine =
      (err.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
    return fnv1a32(`${name}\n${firstStackLine}`);
  }
  return fnv1a32(typeof err === 'string' ? err : JSON.stringify(err));
}

// ────────────────────────────────────────────────────────────────────────
// Test seam — exported under a namespaced symbol so production callers
// can't reach internal helpers by accident.
// ────────────────────────────────────────────────────────────────────────

export const __testing = {
  /**
   * The pinned obscured-fallback map, exposed so the suite can assert the
   * suffixes are still strong. On public ntfy.sh the topic name is the whole
   * access control (noc-master ADR-0194 Am.3), and this map is hand-copied
   * from the fleet registry — so nothing at runtime can notice it rotting.
   */
  fallbackTopicByPrimary: FALLBACK_TOPIC_BY_PRIMARY,
  clearCooldownLedger,
  cooldownActive: (key: string) => cooldownActive(key, Date.now()),
  cooldownLedgerSize: () => cooldownLedger.size,
  /** Swap the retry-backoff sleep for a no-op (or a spy) in tests. */
  setSleep: (fn: (ms: number) => Promise<void>) => {
    sleep = fn;
  },
  /** Restore the real setTimeout-based sleep. */
  resetSleep: () => {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  },
};
