// ADR-0130 — the ONE ADR-0037 cooldown ledger, durable across process exit.
//
// ## Why this file exists
//
// Both ntfy publishers kept their cooldown in a module-scope `Map`. `src/lib/ntfy.ts`
// said why: "One ledger per Node.js process… DR3-Vision runs a single replica on
// CHAD-HQ so this is sufficient. If we scale out, swap in a Redis SETNX backend."
//
// The replica count was never the load-bearing assumption. `dr3-vision-mymrc-scrape`
// is a cron HOST that spawns `scripts/mymrc-scrape.mjs` as a FRESH child process
// every hour and reaps it (`spawning /app/scripts/mymrc-scrape.mjs` →
// `scrape exit code 0`, hourly). A new process gets a new empty Map, so a 24 h
// cooldown decayed to zero and every stale-mirror alert re-fired every hour for four
// days. The same class hits every publisher after a deploy: `swarmpilot_deployer`
// recreates ~19 containers, every in-memory ledger is wiped, and every currently-true
// alert condition re-pages at once.
//
// ## Why Postgres, and not Redis or a file
//
// Verified on CHAD-HQ 2026-09-07, not assumed:
//   • Redis — six Redis containers run on the host (callvault, lodestar, helix-hub,
//     droneopsmap, svdp-intranet, svdp-guardian) and NOT ONE is reachable from
//     DR3-Vision. Per CLAUDE.md "Build context" and `docker network ls`, DR3-Vision
//     joins only its own bridge `dr3-vision_dr3net`. Adding Redis means adding a
//     seventh container, a seventh thing to monitor, for a table with one column.
//   • A file-backed ledger — `docker-compose.yml` declares exactly two volumes,
//     `postgres-data` and `mymrc-auth-state`. NO volume is mounted into more than
//     one of the alerting containers, so a file ledger would be per-container: the
//     same defect with a longer TTL.
//   • Postgres — `dr3-vision-postgres` is on `dr3net`, every publishing process
//     already holds (or trivially can hold) a client, and it is already the store
//     of record for every other cross-process claim in this repo
//     (`idempotency_keys`, the `mymrc_sync_runs` ledger). One indexed table, no new
//     moving part.
//
// ## Why this file lives under mymrc/
//
// Same forced placement as `header-safe.ts` (ADR-0019.5): `tsconfig.mymrc.json`
// pins `rootDir: ./src/lib/mymrc`, so the alias-less MyMRC bundle CANNOT import
// anything above that directory. The one implementation goes inside the narrower
// rootDir and is re-exported upward as `src/lib/ntfy-cooldown-store.ts`. Moving it
// out breaks `RUN npx tsc --project tsconfig.mymrc.json` in the Docker build with
// TS6059 — not the test suite.
//
// ## Zero imports, on purpose
//
// `src/lib/ntfy.ts` documents that it must stay bundleable for edge/browser targets
// (no `node:crypto`, no Prisma). So this module never imports `@prisma/client`; it
// takes an INJECTED client through a minimal structural type. `PrismaClient`
// satisfies it; anything without `$executeRawUnsafe` fails to compile at the
// registration call — the fail-closed seam.

/**
 * The one database capability this ledger needs.
 *
 * REQUIRED, not optional: a client that cannot run the atomic claim must fail at
 * the `setCooldownDb` call site rather than register successfully and degrade
 * silently to the behaviour this ADR exists to delete. `PrismaClient` (and a
 * `$transaction` tx handle) satisfy it structurally.
 *
 * `$executeRawUnsafe` — "Unsafe" names the SQL TEXT, not the parameters. The SQL
 * here is a compile-time constant and every value is a POSITIONAL parameter
 * (`$1/$2/$3`), which is the parameterized form; this is the same idiom
 * `inbound-bridge.ts` and `processed-bridge.ts` use for their atomic upserts. It
 * returns the number of rows the statement affected, which is exactly the claim
 * verdict we need and which `$queryRaw` cannot give us.
 */
export interface CooldownDb {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

/** The outcome of asking for a cooldown window. */
export interface CooldownClaim {
  /** True when THIS caller owns the window and should publish. */
  claimed: boolean;
  /** The expiry this caller wrote, echoed back so `releaseCooldown` can be exact. */
  expiresAt: number;
  /** True when the verdict came from the database rather than the in-process map. */
  durable: boolean;
}

const TABLE = 'alert_cooldowns';

/**
 * Claim-or-refuse in ONE statement. Postgres reports 1 row affected when the row
 * was inserted OR when the `DO UPDATE` ran, and 0 when the `WHERE` blocked the
 * update — i.e. when an unexpired claim already exists. That makes the read and
 * the write a single atomic operation with no check-then-act race between two
 * processes that woke on the same cron minute.
 *
 * `timestamptz` (the repo otherwise defaults to `timestamp(3)`) for the same reason
 * `users.sessions_invalidated_at` uses it: this is a BARE INSTANT compared across
 * processes, and a zone-naive column would make the comparison depend on the
 * session `TimeZone` of whichever container wrote it.
 *
 * TWO DELIBERATE DETAIL DIFFERENCES from the SQL as written in ADR-0130 D2, both
 * inside the shape D2 specifies (atomic conditional upsert, claim-or-refuse):
 *
 *  1. `$3` carries the CALLER'S instant rather than Postgres `now()`. D2's clock
 *     source is the database; ours is the process. There is no second clock to
 *     disagree with — the app and the database are containers on one host — and an
 *     injectable instant is what lets the suite replay twenty-four hourly ticks and
 *     assert exactly one claim, which `now()` makes untestable.
 *  2. The verdict is the AFFECTED-ROW COUNT, not `RETURNING key`. Both say the same
 *     thing; the count needs only `$executeRawUnsafe`, which keeps the injected
 *     `CooldownDb` down to ONE required method and therefore keeps the
 *     fail-closed-on-compile seam as narrow as possible.
 */
const CLAIM_SQL = `
INSERT INTO "${TABLE}" ("key", "expires_at", "last_sent_at", "send_count")
VALUES ($1, $2::timestamptz, $3::timestamptz, 1)
ON CONFLICT ("key") DO UPDATE
   SET "expires_at"   = EXCLUDED."expires_at",
       "last_sent_at" = EXCLUDED."last_sent_at",
       "send_count"   = "${TABLE}"."send_count" + 1
 WHERE "${TABLE}"."expires_at" <= $3::timestamptz`;

/**
 * Give the window back. Guarded on the exact expiry we wrote so a release can
 * never delete a NEWER claim taken by another process between our claim and our
 * failed publish.
 */
const RELEASE_SQL = `
DELETE FROM "${TABLE}"
 WHERE "key" = $1 AND "expires_at" = $2::timestamptz`;

/** Bound growth. Anything expired past the grace window is dead weight. */
const REAP_SQL = `
DELETE FROM "${TABLE}" WHERE "expires_at" < $1::timestamptz`;

/**
 * Expired rows are kept this long before reaping, purely so an operator debugging
 * "why did/didn't this page" can still see the last window. Nothing reads them.
 */
const REAP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * At most one reap per process per interval. A one-shot worker therefore reaps
 * exactly once per run (cheap: one indexed DELETE); a long-lived process reaps
 * hourly. Deliberately NOT probabilistic — a sampled reap cannot be tested.
 */
let reapIntervalMs = 60 * 60 * 1000;
let lastReapAt = 0;

// ── In-process fallback ledger ───────────────────────────────────────────────
//
// Retained, but demoted from "the ledger" to "the backstop". It is the behaviour
// when (a) no database has been registered — a unit test, a CLI, an edge bundle —
// or (b) the database call THREW. A DB outage must not silence the fleet, and it
// must not re-open the storm within a single process either.

const memoryLedger = new Map<string, number>();

/** Eviction guard — unchanged from the pre-ADR-0130 ledger, tested at the 10k boundary. */
const MEMORY_LEDGER_MAX = 10_000;

function memoryClaim(key: string, now: number, expiresAt: number): boolean {
  const existing = memoryLedger.get(key);
  if (existing !== undefined) {
    if (existing > now) return false;
    memoryLedger.delete(key);
  }
  memoryRecord(key, expiresAt);
  return true;
}

function memoryRecord(key: string, expiresAt: number): void {
  if (memoryLedger.size >= MEMORY_LEDGER_MAX) {
    // Evict the oldest half by re-walking. O(n) but n is bounded and this fires at
    // most once per 10k publishes, so the amortised cost is negligible.
    const entries = [...memoryLedger.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < entries.length / 2; i++) {
      const entry = entries[i];
      if (entry) memoryLedger.delete(entry[0]);
    }
  }
  memoryLedger.set(key, expiresAt);
}

// ── Registration ─────────────────────────────────────────────────────────────

let db: CooldownDb | null = null;
let warnedUnregistered = false;

/**
 * Point the ledger at a database. Called once per process at its composition root:
 * `instrumentation.ts` for the Next app, and the worker entry point for each
 * stand-alone `.mjs` that publishes. Passing `null` reverts to the in-process
 * backstop (what tests and CLIs get).
 */
export function setCooldownDb(next: CooldownDb | null): void {
  db = next;
  warnedUnregistered = false;
}

/** Whether a durable backend is registered in this process. */
export function hasCooldownDb(): boolean {
  return db !== null;
}

/**
 * Structured, single-line, JSON. `console.error`, not the pino logger, for the same
 * reason `src/lib/ntfy.ts` uses it: this module must stay free of `node:crypto` and
 * of pino so it bundles into edge/browser targets. Alloy still ships it to Loki in
 * a queryable shape.
 */
function logLine(level: number, fields: Record<string, unknown>): void {
  const write = level >= 50 ? console.error : console.warn;
  write(JSON.stringify({ level, op: 'ntfy-cooldown', ...fields }));
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ask for the cooldown window for `fingerprint`.
 *
 * Returns `claimed: true` when the caller owns the window and should publish, and
 * `claimed: false` when an unexpired claim already exists (ADR-0037
 * `cooldown-suppressed`).
 *
 * NEVER THROWS. A pager failure must not fail its caller — `checkMirrorFreshness`
 * explicitly `.catch(() => undefined)`s the page, and a throw from the LEDGER would
 * land inside that catch and be indistinguishable from a delivery failure.
 */
export async function claimCooldown(
  fingerprint: string,
  cooldownMs: number,
  nowMs?: number,
): Promise<CooldownClaim> {
  const now = nowMs ?? Date.now();
  const expiresAt = now + cooldownMs;

  const backend = db;
  if (backend === null) {
    if (!warnedUnregistered) {
      warnedUnregistered = true;
      // Not silent: an unregistered process is the pre-ADR-0130 behaviour, and
      // "shipped disabled" must not look identical to "shipped working".
      logLine(40, {
        msg: '[ntfy-cooldown] no durable ledger registered - falling back to the in-process map (cooldowns will NOT survive process exit)',
      });
    }
    return { claimed: memoryClaim(fingerprint, now, expiresAt), expiresAt, durable: false };
  }

  try {
    const affected = await backend.$executeRawUnsafe(
      CLAIM_SQL,
      fingerprint,
      isoOf(expiresAt),
      isoOf(now),
    );
    const claimed = affected > 0;
    // Mirror a won claim into the in-process map so a later DB outage in the SAME
    // process cannot re-open the window this process already used.
    if (claimed) memoryRecord(fingerprint, expiresAt);
    await reapIfDue(backend, now);
    return { claimed, expiresAt, durable: true };
  } catch (err) {
    logLine(50, {
      fingerprint,
      reason: describeError(err),
      msg: '[ntfy-cooldown] durable claim failed - degrading to the in-process ledger for this call',
    });
    return { claimed: memoryClaim(fingerprint, now, expiresAt), expiresAt, durable: false };
  }
}

/**
 * Release a claim taken by {@link claimCooldown} because the publish did not land.
 *
 * ADR-0036/0037 contract: a `dropped` publish (primary AND fallback both failed)
 * leaves the caller free to retry on the next watchdog tick. Claiming BEFORE the
 * send is what makes the claim atomic; giving the claim back on a drop is what
 * keeps that contract. Without this, one transient ntfy outage would silence an
 * alert for its whole cooldown window.
 *
 * Never throws.
 */
export async function releaseCooldown(fingerprint: string, expiresAt: number): Promise<void> {
  memoryLedger.delete(fingerprint);
  const backend = db;
  if (backend === null) return;
  try {
    await backend.$executeRawUnsafe(RELEASE_SQL, fingerprint, isoOf(expiresAt));
  } catch (err) {
    logLine(50, {
      fingerprint,
      reason: describeError(err),
      msg: '[ntfy-cooldown] claim release failed - this fingerprint stays suppressed until its window expires',
    });
  }
}

/** Throttled reap of long-expired rows. Never throws; failure is logged, not raised. */
async function reapIfDue(backend: CooldownDb, now: number): Promise<void> {
  if (now - lastReapAt < reapIntervalMs) return;
  lastReapAt = now;
  try {
    const removed = await backend.$executeRawUnsafe(REAP_SQL, isoOf(now - REAP_GRACE_MS));
    if (removed > 0) logLine(30, { removed, msg: '[ntfy-cooldown] reaped expired rows' });
  } catch (err) {
    logLine(50, { reason: describeError(err), msg: '[ntfy-cooldown] reap failed' });
  }
}

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return `${e?.name ?? 'Error'}: ${(e?.message ?? String(err)).slice(0, 200)}`;
}

// ── Test seam ────────────────────────────────────────────────────────────────

export const __cooldownTesting = {
  /** Reset every module-scope bit of state. Vitest calls this between tests. */
  reset(): void {
    memoryLedger.clear();
    db = null;
    warnedUnregistered = false;
    lastReapAt = 0;
    reapIntervalMs = 60 * 60 * 1000;
  },
  memorySize: (): number => memoryLedger.size,
  memoryActive: (key: string): boolean => {
    const at = memoryLedger.get(key);
    return at !== undefined && at > Date.now();
  },
  memoryRecord,
  setReapIntervalMs: (ms: number): void => {
    reapIntervalMs = ms;
  },
  sql: { CLAIM_SQL, RELEASE_SQL, REAP_SQL, REAP_GRACE_MS },
};
