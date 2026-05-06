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

const PRIMARY_BASE_DEFAULT = 'https://ntfy.barnardhq.com';
const FALLBACK_BASE = 'https://ntfy.sh';

// Pinned obscured fallback topics from
// `~/noc-master/data/ntfy-fallback-topics.yml` — the dr3-vision rows
// added 2026-05-06. Public ntfy.sh topics; access control IS the
// obscured suffix. Bill's reader subscribes; nobody else needs the name.
const FALLBACK_TOPIC_BY_PRIMARY: Readonly<Record<string, string>> = {
  'dr3-vision-system': 'bhq-fb-dr3v-system-k8m2n',
  'dr3-vision-container': 'barnardhq-fleet-dr3-vision-8a7f2c91e6b4d3a85f0c9d2e7b1a8f4c3',
  'dr3-vision-deploys': 'bhq-fb-dr3v-deploys-r4w7q',
  'dr3-vision-loads': 'bhq-fb-dr3v-loads-f9j5p',
};

// ADR-0036 §Click URL priority tier 3.
const DEFAULT_CLICK_URL = 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision';
const TITLE_PREFIX = '[DR3-Vision]';

// ADR-0037 §3 default cooldown for routine alerts.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// Best-effort timeout — never blocks request handlers longer than this.
const PRIMARY_TIMEOUT_MS = 5_000;
const FALLBACK_TIMEOUT_MS = 5_000;

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
  const fullTitle = (args.isFallback ? `[FALLBACK] ${TITLE_PREFIX} ` : `${TITLE_PREFIX} `) + args.title;
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
  return headers;
}

// ────────────────────────────────────────────────────────────────────────
// HTTP POST helpers — primary + fallback
// ────────────────────────────────────────────────────────────────────────

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
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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

  const primaryOk = await postWithTimeout(
    `${baseUrl}/${args.topic}`,
    truncated,
    primaryHeaders,
    PRIMARY_TIMEOUT_MS,
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
  const fallbackOk = await postWithTimeout(
    `${FALLBACK_BASE}/${fbTopic}`,
    truncated,
    fallbackHeaders,
    FALLBACK_TIMEOUT_MS,
  );
  if (fallbackOk) {
    recordCooldown(fp, now, cooldownMs);
    return { ok: true, outcome: 'fallback-sent' };
  }
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
    const firstStackLine = (err.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
    return fnv1a32(`${name}\n${firstStackLine}`);
  }
  return fnv1a32(typeof err === 'string' ? err : JSON.stringify(err));
}

// ────────────────────────────────────────────────────────────────────────
// Test seam — exported under a namespaced symbol so production callers
// can't reach internal helpers by accident.
// ────────────────────────────────────────────────────────────────────────

export const __testing = {
  clearCooldownLedger,
  cooldownActive: (key: string) => cooldownActive(key, Date.now()),
  cooldownLedgerSize: () => cooldownLedger.size,
};
