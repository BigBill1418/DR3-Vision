// ADR-0057 Phase 1 (D3 addendum, 2026-07-22) — the BATCH detail-enrichment engine.
//
// Drives the proven batched getRecordWithFields transport (record-fields-client.ts)
// over the backfill targets to fill every mirror row still lacking billing fields.
// This is the id-driven detail pass: it reads `detail_fetched_at IS NULL` per
// mirror (no pagination — the ids are already in the mirror from the list pass /
// backfill), chunks 100 ids per POST, maps each returned SfRecord through the
// EXISTING mappers/writeDetail, and stamps `detail_fetched_at`. Resumable and
// idempotent off the null-cursor; a crash just re-selects the still-null rows.
//
// `sweepTargetDetail` is the ONE batch-sweep primitive shared by:
//   • the windowed backfill engine (backfill.ts) — its detail pass after paging, and
//   • the one-shot enrichment runner (scripts/mymrc-enrich-details.mjs) — the
//     whole-backlog sweep.
// so the "transport swap" lands in exactly one place. The steady-state hourly
// sync (sync.ts) uses the same RecordFieldsClient directly on its per-tick id set.
//
// Loud failure (ADR-0038 D4): a batch that returns ZERO SUCCESS while ids were
// requested, or a logged-out session after re-auth, pages `dr3-vision-system` —
// never a silent green.
//
// Bundle constraint: compiles standalone via tsconfig.mymrc.json — no `@/…`.

import type { PrismaClient } from '@prisma/client';
import type { BackfillTarget } from './backfill';
import { AuthFailedError } from './portal-client';
import { ntfyPager, type Pager } from './ntfy';
import { chunkIds, type BatchActionError, type RecordFieldsClient } from './record-fields-client';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

const DEFAULT_BATCH_SIZE = 100; // proven clean to 200; 100 = ~70 KB / ~0.5 s per POST
const DEFAULT_PACING_MS = 1_000; // ≥1 s between POSTs (politeness / backoff headroom)
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Outcome of sweeping one target's `detail_fetched_at IS NULL` ids in batches. */
export interface DetailSweepResult {
  /** Ids requested (the null set at sweep start). */
  requested: number;
  /** Records successfully mapped + upserted + stamped. */
  fetched: number;
  /** Per-id action errors (FLS-hidden / deleted), named for diagnosis — never dropped. */
  errors: BatchActionError[];
  /** Ids neither returned SUCCESS nor ERROR (transport gap) — stay null, retried next pass. */
  missing: number;
  /** Batches that returned zero SUCCESS while ids were requested (loud-failure signal). */
  zeroSuccessBatches: number;
  /** The session went logged-out and could not self-heal — sweep aborted. */
  auth: boolean;
  authMessage: string;
}

export interface SweepOptions {
  batchSize?: number;
  pacingMs?: number;
  now?: Date;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sweep one target's outstanding detail. Selects `idsNeedingDetail()` (the mirror's
 * `detail_fetched_at IS NULL` set), chunks `batchSize`, POSTs each chunk through
 * the batched getRecordWithFields transport with the target's `optionalFields`,
 * and writes each returned record via the target's existing `writeDetail` (which
 * stamps `detail_fetched_at`). Per-batch: SUCCESS → upsert+stamp; ERROR → recorded
 * for retry; neither → counted missing (retried next pass). An AuthFailedError
 * aborts the sweep (the whole session is dead). Sequential with `pacingMs` between
 * POSTs.
 */
export async function sweepTargetDetail(
  target: BackfillTarget,
  client: RecordFieldsClient,
  opts: SweepOptions = {},
): Promise<DetailSweepResult> {
  const log = opts.log ?? noopLog;
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const pacingMs = Math.max(0, opts.pacingMs ?? DEFAULT_PACING_MS);
  const sleep = opts.sleep ?? realSleep;

  const pending = await target.idsNeedingDetail();
  const result: DetailSweepResult = {
    requested: pending.length,
    fetched: 0,
    errors: [],
    missing: 0,
    zeroSuccessBatches: 0,
    auth: false,
    authMessage: '',
  };
  if (pending.length === 0) return result;

  const batches = chunkIds(pending, batchSize);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batch === undefined || batch.length === 0) continue;

    let res;
    try {
      res = await client.fetchRecordFields(batch, target.optionalFields);
    } catch (err) {
      if (err instanceof AuthFailedError) {
        result.auth = true;
        result.authMessage = err.message;
        return result; // session dead — abort; a re-auth'd re-run resumes off the null cursor
      }
      throw err; // an unexpected transport failure surfaces (engine maps it to a wedge)
    }

    for (const [, record] of res.records) {
      await target.writeDetail(record, now);
      result.fetched += 1;
    }
    result.errors.push(...res.errors);
    result.missing += batch.length - res.records.size - res.errors.length;
    if (res.records.size === 0) {
      result.zeroSuccessBatches += 1;
      log(
        'error',
        `mymrc-enrich: ${target.objectApiName}/${target.listViewApiName || '(default)'} batch ${b + 1}/${batches.length} ` +
          `returned ZERO records for ${batch.length} requested id(s) (${res.errors.length} error(s))`,
      );
    } else {
      log(
        'info',
        `mymrc-enrich: ${target.objectApiName}/${target.listViewApiName || '(default)'} batch ${b + 1}/${batches.length} → ` +
          `${res.records.size}/${batch.length} ok (${res.errors.length} error(s))`,
      );
    }
    if (pacingMs > 0 && b < batches.length - 1) await sleep(pacingMs);
  }
  return result;
}

// ── Whole-backlog enrichment engine ──────────────────────────────────────────

export interface EnrichTargetResult {
  objectApiName: string;
  listViewApiName: string;
  requested: number;
  fetched: number;
  errored: number;
  missing: number;
  /** The errored record ids (named for the operator — FLS/deleted), capped for log sanity. */
  erroredIds: string[];
  auth: boolean;
}

export interface EnrichResult {
  targets: EnrichTargetResult[];
  /** Every target swept without an auth failure. */
  complete: boolean;
}

export interface EnrichContext {
  prisma: PrismaClient;
  client: RecordFieldsClient;
  targets: readonly BackfillTarget[];
  pager?: Pager;
  log?: Logger;
  now?: () => Date;
  batchSize?: number;
  pacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Enrich the whole detail backlog: sweep every target's `detail_fetched_at IS NULL`
 * set in 100-id batches. Sequential (targets share ONE authenticated session).
 * Loud failure (ADR-0038 D4): a target whose sweep produced any zero-SUCCESS batch,
 * or that logged out, pages `dr3-vision-system`. Never throws — every terminal
 * condition is captured in the per-target result.
 */
export async function enrichDetails(ctx: EnrichContext): Promise<EnrichResult> {
  const log = ctx.log ?? noopLog;
  const pager = ctx.pager ?? ntfyPager;
  const now = (ctx.now ?? ((): Date => new Date()))();
  const targets: EnrichTargetResult[] = [];

  for (const target of ctx.targets) {
    const swept = await sweepTargetDetail(target, ctx.client, {
      now,
      ...(ctx.batchSize !== undefined ? { batchSize: ctx.batchSize } : {}),
      ...(ctx.pacingMs !== undefined ? { pacingMs: ctx.pacingMs } : {}),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      log,
    });
    const erroredIds = swept.errors.map((e) => e.recordId);
    targets.push({
      objectApiName: target.objectApiName,
      listViewApiName: target.listViewApiName,
      requested: swept.requested,
      fetched: swept.fetched,
      errored: swept.errors.length,
      missing: swept.missing,
      erroredIds: erroredIds.slice(0, 50),
      auth: swept.auth,
    });

    if (swept.auth) {
      await pager
        .page({
          kind: 'auth_failed',
          site: target.objectApiName,
          message: `MyMRC enrichment logged out sweeping ${target.objectApiName} detail: ${swept.authMessage}`,
          fingerprint: `mymrc-enrich-auth:${target.objectApiName}`,
        })
        .catch(() => undefined);
      log('error', `mymrc-enrich: ${target.objectApiName} AUTH FAILED — ${swept.authMessage}`);
      continue;
    }
    if (swept.zeroSuccessBatches > 0) {
      await pager
        .page({
          kind: 'error',
          site: target.objectApiName,
          message:
            `MyMRC enrichment: ${swept.zeroSuccessBatches} batch(es) returned ZERO records for ` +
            `${target.objectApiName}/${target.listViewApiName || '(default)'} (requested ${swept.requested}, ` +
            `fetched ${swept.fetched}, errors ${swept.errors.length}). Resumes off the null cursor next run.`,
          fingerprint: `mymrc-enrich-zero:${target.objectApiName}:${target.listViewApiName}`,
        })
        .catch(() => undefined);
    }
    if (swept.requested > 0) {
      log(
        'info',
        `mymrc-enrich: ${target.objectApiName}/${target.listViewApiName || '(default)'} — ` +
          `requested=${swept.requested} fetched=${swept.fetched} errors=${swept.errors.length} missing=${swept.missing}`,
      );
    }
  }

  return { targets, complete: targets.every((t) => !t.auth) };
}
