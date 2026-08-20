// ADR-0049 D1/D2/D3/D5/D11 — the workbook sync engine.
//
// One poll tick, per active source:
//   discover the current month's file (D5 rollover) → delta-detect by cTag (D2: no
//   re-download when unchanged) → download → parse via the SHARED ADR-0048/0039
//   `parseWorkbook` + the daily adapter → upsert into `processed_units_daily` under
//   the workbook-wins rule with an audit row per Vision-overwrite (D3) → mid-edit
//   rows skipped + counted, retried next poll, NO alert (D11) → a `workbook_sync_runs`
//   ledger row ALWAYS (incl. throw / fail-soft paths). Post-cutover (surface flipped
//   `live`, D7) the sync is a NO-OP.
//
// Business-hours enforcement lives at the ROUTE (D2) so the engine stays test-time
// agnostic. A missing `Files.Read.All` grant surfaces as FilesForbiddenError →
// status `forbidden`, fail-soft: log + ntfy Bill + ledger, never a crash
// (test-plan line 8).

import { randomUUID } from 'node:crypto';
import type { PrismaClient, WorkbookSource } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { publishNtfy } from '@/lib/ntfy';
import { getRolloutState } from '@/lib/notify/rollout';
import { UnregisteredSurfaceError } from '@/lib/notify/errors';
import { WORKBOOK_SYNC_SURFACE } from './surface';
import { parseWorkbook } from '@/lib/audit/workbook/parser';
import {
  FilesForbiddenError,
  selectFilesTransport,
  type FilesTransport,
  type FilesTransportLogger,
} from '@/lib/msgraph-files';
import { deriveDailyRows, type DailySiteScope } from './daily-adapter';
import { sourceAliasResolver } from '@/lib/audit/workbook/site-alias';
import {
  resolveMonthlyFileName,
  resolveMonthlyFolderPath,
  yearMonthKeyFromFileName,
} from './naming';
import { billedDaysFor, isGraceWindowOpen, priorMonthAnchor } from './grace';
import { upsertDailyProduction } from './upsert';

export type SyncStatus = 'ok' | 'forbidden' | 'not_found' | 'error' | 'skipped';

// ── ADR-0049 Am.3 A4 — alarm policy, graded against the ADR-0037 5-question gate ──
//
// What was wrong: `not_found` logged at INFO and never reached the catch block
// that holds the ntfy calls, so a renamed / typo'd / copied file went silent
// FOREVER. An unreadable rollout state was recorded `ok` + `cutover_noop: true` —
// asserting a site was cut over when it was not. And a refusal re-fired every 10
// minutes with a 30-minute cooldown held in PROCESS MEMORY, i.e. ~28 identical
// pages per business day, reset to zero by every container restart.
//
// The gate, applied honestly:
//   Q1 actionable in 5 min?  A stuck workbook needs Kelsey, not an operator at
//                            02:00 — so `high`, never `urgent`.
//   Q2 customer-visible?     Not directly; it silently staleness Vision's billed
//                            production figures, which is why it must page at all.
//   Q3 self-heal first?      Yes — the FIRST failure of a streak pages, and a new
//                            month's not-yet-created file is inside the grace
//                            window and pages nothing.
//   Q4 deduplicated?         One page per SITE, not one per poll and not one per
//                            failing check.
//   Q5 useful click?         Tier-2 — the operator's own workbook-sync page.
//
// Cadence: page on the first failure of a streak, then at most once per 24 h per
// site, held in `workbook_sources.last_alert_at` so a restart cannot reset it.

/** Page at most this often per site once a failure streak is established. */
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * How long a source may produce NO successful read before it is treated as dead.
 *
 * Deliberately longer than a long weekend: polling is Mon–Fri only (D2), so a
 * Friday-evening breakage is legitimately silent until Monday and a 2-day window
 * would page every Monday morning for nothing. Also covers the documented, correct
 * `not_found` on the 1st of a month before Kelsey creates the new file.
 */
const STALE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

/** Tier-2 click target (ADR-0036): the page an operator can actually act from. */
const SYNC_CLICK_URL = 'https://dr3-vision.svdp.us/admin/workbook-sync';

/**
 * Thrown when a non-`graph` transport reaches the write step. Never caught into
 * a clean run: a fixture write over real production figures is not recoverable,
 * so this must surface as a FAILED run with the reason on the ledger row.
 */
export class WorkbookSyncMockWriteRefused extends Error {
  override readonly name = 'WorkbookSyncMockWriteRefused';
}

/**
 * Thrown when the daily adapter could not READ the workbook — an unrecognised
 * template generation, an unresolvable daily-close layout, a file whose every day
 * is unusable, or a file that belongs to another site.
 *
 * This exists so that outcome can never be recorded as a clean `ok` with
 * `rowsUpserted: 0`. A zero that means "I could not read it" and a zero that
 * means "there was nothing to write" are different facts, and this codebase has
 * repeatedly shipped the first one disguised as the second.
 */
export class WorkbookDailyLayoutUnreadable extends Error {
  override readonly name = 'WorkbookDailyLayoutUnreadable';
}
export type SyncLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: SyncLogger = () => undefined;

export interface SyncOneResult {
  sourceId: string;
  siteId: string;
  status: SyncStatus;
  transportMode: 'mock' | 'graph';
  fileName: string | null;
  changesDetected: boolean;
  cutoverNoop: boolean;
  rowsUpserted: number;
  rowsSkippedMidedit: number;
  rowsOverwritten: number;
  /** ADR-0049 Am.4 B1 — this result is a prior-month catch-up read, not the live month. */
  graceWindow: boolean;
  /** Days left alone because an approved invoice already covers them (B1). */
  rowsSkippedBilled: number;
  /**
   * ADR-0123 — days left alone because a PERSON owns the row (`source = 'manual'`).
   *
   * Non-zero means the spreadsheet and a human correction disagree. Like
   * `rowsSkippedBilled`, that is a human decision this sync deliberately does not
   * make; unlike it, the previous behaviour was to overwrite the human.
   */
  rowsSkippedManual: number;
  error: string | null;
  runId: string;
  /** Whether this poll fired an ntfy page (A4 — one `high` per site per day). */
  paged: boolean;
}

export interface RunPollResult {
  transportMode: 'mock' | 'graph';
  sourcesPolled: number;
  results: SyncOneResult[];
}

/**
 * ADR-0049 Am.4 B1 — which month a poll is reading.
 *
 * `current` is the D5 behaviour, unchanged. `grace` re-reads the PRIOR month's
 * workbook while its close-out window is open, so an edit Kelsey makes on the 3rd
 * to the month that ended on the 31st still reaches Vision.
 */
export type SyncTarget = 'current' | 'grace';

export interface SyncContext {
  prisma?: PrismaClient;
  transport?: FilesTransport;
  now?: () => Date;
  log?: SyncLogger;
  /** Limit to one site (tests / a targeted re-poll). */
  siteId?: string;
  /**
   * TESTS ONLY — permit a non-`graph` transport to reach the write step.
   *
   * `selectFilesTransport` falls back to a FIXTURE-seeded mock whenever the
   * MSGRAPH_* creds are absent, and the write step used to run regardless. So an
   * env regression (rotated secret, dropped var) would quietly write the
   * June-Woodland fixture into `processed_units_daily` under workbook-wins, with
   * the run ledger saying `ok` — "I am not really connected" recorded as "fine".
   *
   * Production NEVER sets this. The cron passes no context, so the default
   * (`false`) is what runs against real data; only a test that is deliberately
   * exercising the upsert path through the mock opts in.
   */
  allowNonGraphWrites?: boolean;
}

/** Poll every ACTIVE (`is_syncing`) source. Disabled sources are skipped entirely. */
export async function runWorkbookSyncPoll(ctx: SyncContext = {}): Promise<RunPollResult> {
  const prisma = ctx.prisma ?? defaultPrisma;
  const log = ctx.log ?? noopLog;
  const transport = ctx.transport ?? (await selectFilesTransport(log as FilesTransportLogger));

  const sources = await prisma.workbookSource.findMany({
    where: { is_syncing: true, ...(ctx.siteId ? { site_id: ctx.siteId } : {}) },
    orderBy: { created_at: 'asc' },
  });

  const nowFn = ctx.now ?? ((): Date => new Date());
  const results: SyncOneResult[] = [];
  for (const source of sources) {
    results.push(await syncOneSource({ ...ctx, prisma, transport, log }, source, 'current'));

    // ADR-0049 Am.4 B1 — the prior month stays readable for a bounded window into
    // the new one. Ordered AFTER the current-month poll deliberately: the live
    // month is what an operator is watching today, so it must never be delayed or
    // starved by a catch-up read of a month that has already ended.
    if (isGraceWindowOpen(nowFn())) {
      results.push(await syncOneSource({ ...ctx, prisma, transport, log }, source, 'grace'));
    }
  }
  return { transportMode: transport.mode, sourcesPolled: sources.length, results };
}

interface ResolvedCtx extends SyncContext {
  prisma: PrismaClient;
  transport: FilesTransport;
  log: SyncLogger;
}

export async function syncOneSource(
  ctx: ResolvedCtx,
  source: WorkbookSource,
  target: SyncTarget = 'current',
): Promise<SyncOneResult> {
  const { prisma, transport, log } = ctx;
  const allowNonGraphWrites = ctx.allowNonGraphWrites === true;
  const nowFn = ctx.now ?? ((): Date => new Date());
  const runId = randomUUID();
  const started = nowFn();
  const mode = transport.mode;
  const isGrace = target === 'grace';
  /** The month this poll reads: now, or an instant inside the prior month (B1). */
  const monthAnchor = isGrace ? priorMonthAnchor(started) : started;
  const tag = isGrace ? ' [grace]' : '';
  let rowsSkippedBilled = 0;
  let rowsSkippedManual = 0;

  let status: SyncStatus = 'ok';
  let error: string | null = null;
  let fileName: string | null = null;
  let changesDetected = false;
  let cutoverNoop = false;
  let rowsUpserted = 0;
  let rowsSkippedMidedit = 0;
  let rowsOverwritten = 0;
  /** True only when the workbook was READ end to end (delta no-op counts). */
  let workbookRead = false;

  try {
    // Post-cutover (surface live) ⇒ sync is a no-op (D7). The ERROR direction
    // matters (2026-07-10 audit): if the rollout read FAILS we cannot know
    // whether the site is cut over, and resuming the workbook-wins upsert on a
    // cut-over site would overwrite live Vision-captured rows — the one
    // irreversible outcome. So an unreadable state SKIPS this poll (no-op, run
    // ledger says so); a transient DB blip costs one 10-minute cycle,
    // pre-cutover or post. Only an explicit 'pilot'/unregistered read keeps
    // syncing.
    let cutoverLive = false;
    let rolloutUnreadable: string | null = null;
    try {
      cutoverLive =
        (await getRolloutState({
          db: prisma,
          kind: 'workbook_sync',
          surfaceCode: WORKBOOK_SYNC_SURFACE,
          siteId: source.site_id,
        })) === 'live';
    } catch (e) {
      if (e instanceof UnregisteredSurfaceError) {
        // Deterministic answer, not a failure: an unregistered surface IS
        // pilot (pre-cutover) — keep syncing.
        cutoverLive = false;
      } else {
        cutoverLive = true; // fail SAFE: unknown cutover state ⇒ do not upsert
        rolloutUnreadable = describe(e);
        log(
          'warn',
          `[workbook-sync] run=${runId} site=${source.site_id} rollout-state read failed — skipping poll (fail-safe): ${rolloutUnreadable}`,
        );
      }
    }
    if (rolloutUnreadable !== null) {
      // ADR-0049 Am.3 A4 — the fail-safe DIRECTION is right and unchanged; the
      // RECORDING was wrong. This used to be written `status: 'ok'` +
      // `cutover_noop: true`, a row asserting the site is cut over when we do not
      // know that and the sync has silently stopped feeding Vision. `cutover_noop`
      // stays FALSE: no cutover was read, so none can be claimed.
      status = 'skipped';
      error =
        `rollout state unreadable — skipping this poll rather than risk overwriting a cut-over ` +
        `site's Vision-captured rows (fail-safe). This is NOT a cutover no-op: whether ` +
        `${source.site_id} is cut over is unknown. Underlying error: ${rolloutUnreadable}`;
    } else if (cutoverLive) {
      cutoverNoop = true;
      log(
        'info',
        `[workbook-sync] run=${runId} site=${source.site_id} CUT OVER (surface live) — no-op`,
      );
    } else {
      fileName = resolveMonthlyFileName(source.naming_pattern, monthAnchor);
      // ADR-0102 — the FOLDER rolls over with the file. Woodland keeps each
      // month's workbook in its own per-month folder inside a per-year folder, so
      // a static `folder_path` is correct for one month and silently wrong after
      // that. Expanded with the SAME `monthAnchor` as the file name, which is what
      // makes the grace window read the prior month's file out of the prior
      // month's folder instead of hunting last month's name in this month's.
      // Token-free paths (including the empty drive-root default) are unchanged.
      const folderPath = resolveMonthlyFolderPath(source.folder_path, monthAnchor);
      const file = await transport.getFile(source.drive_upn, folderPath, fileName);
      // B1 — two files in flight, two watermarks. Reading the wrong one would make
      // each poll invalidate the other's cTag (endless re-downloads) and, in the
      // other direction, let a grace read mark a genuinely-changed current-month
      // file "unchanged" and drop that change.
      const watermarkId = isGrace ? source.grace_file_id : source.last_file_id;
      const watermarkCtag = isGrace ? source.grace_file_ctag : source.last_file_ctag;

      if (!file) {
        status = 'not_found';
        log(
          'info',
          `[workbook-sync] run=${runId} site=${source.site_id}${tag} file "${fileName}" not found ` +
            (isGrace
              ? '(prior month archived or renamed — normal, not a fault)'
              : '(possibly-empty new month)'),
        );
      } else if (file.id === watermarkId && file.ctag === watermarkCtag) {
        // Delta no-op (D2): unchanged cTag ⇒ NO re-download / re-parse. This still
        // counts as a healthy read for A4 — the file is present and identical to
        // the one we last parsed successfully.
        changesDetected = false;
        workbookRead = true;
        log(
          'info',
          `[workbook-sync] run=${runId} site=${source.site_id}${tag} "${fileName}" unchanged (ctag) — no re-download`,
        );
      } else {
        changesDetected = true;
        const bytes = await transport.downloadFile(source.drive_upn, file.id);
        // Shared ADR-0048/0039 parser runs for staging/provenance + template-drift
        // detection (its output is not re-persisted per poll — see ADR-0049 notes);
        // the daily adapter derives the operational rows.
        // ONE parse per poll. The layout-aware parse is both the staging/
        // provenance record AND the source of the operational rows — the daily
        // adapter derives them from it and resolves no columns of its own (D12).
        //
        // ADR-0049 Am.3 A2 — the file name STATES the month, and until now that was
        // used only to fetch the file and stamp the ledger. The parser derived the
        // month from the first dated inbound row it met and compared it to nothing,
        // so one stale copy-forward row in a cleared-down file dated a whole month
        // into the previous month — overwriting closed, billed figures under
        // workbook-wins with the run recorded `ok`. The two are now cross-checked,
        // and the file name also supplies the month when the workbook carries no
        // dated row yet.
        const expectedMonth = yearMonthKeyFromFileName(
          source.naming_pattern,
          file.name ?? fileName,
        );
        const parsed = await parseWorkbook(bytes, { expectedMonth });
        const daily = deriveDailyRows(
          parsed,
          await siteScopeFor(prisma, source.site_id, log),
          expectedMonth,
        );
        rowsSkippedMidedit = daily.midEditCount;

        // ── A MOCK TRANSPORT MUST NEVER WRITE PRODUCTION ─────────────────
        // `selectFilesTransport` falls back to a fixture-seeded mock whenever the
        // MSGRAPH_* creds are absent, and until now nothing checked the mode
        // before upserting. So an env regression — a rotated secret, a dropped
        // var — would not fail loudly: it would quietly write the June-Woodland
        // FIXTURE into `processed_units_daily` under workbook-wins semantics, and
        // the run ledger would say `ok`. That is the exact shape this codebase
        // keeps producing: a state meaning "I am not really connected" recorded
        // as a state meaning "fine".
        //
        // Refuse, loudly, and make the run say why. Doing nothing is always
        // recoverable; writing fixture data over real production figures is not.
        if (mode !== 'graph' && !allowNonGraphWrites) {
          status = 'error';
          error =
            `transport is "${mode}", not graph — refusing to upsert. The MSGRAPH_* credentials are ` +
            `absent or invalid, so the bytes just read are a FIXTURE, not the real workbook. ` +
            `Nothing was written.`;
          log('error', `[workbook-sync] run=${runId} site=${source.site_id} ${error}`);
          throw new WorkbookSyncMockWriteRefused(error);
        }

        // ── A WORKBOOK WE COULD NOT READ MUST NOT LOOK LIKE A CLEAN RUN ──────
        // The adapter refuses rather than guessing (unknown template generation,
        // unresolvable daily-close layout, every day unusable, wrong site). Fail
        // the run with the reason on the ledger so `rowsUpserted: 0` can never be
        // read as "nothing changed". The file watermark is deliberately NOT
        // advanced — the next poll re-reads it.
        if (daily.failure) {
          error = `${daily.failure.kind}: ${daily.failure.message}`;
          if (daily.failure.notEnoughData) {
            // ADR-0049 Am.3 A2/A4 — "the workbook does not carry enough YET" is not
            // a read failure. Recording it as one pages an operator over a file
            // Kelsey simply has not filled in, which fails the ADR-0037 gate on Q1
            // and Q2. Skipped, on the ledger, with the reason, and no page. The
            // watermark is still not advanced, so the next poll re-reads.
            status = 'skipped';
            log('info', `[workbook-sync] run=${runId} site=${source.site_id} ${error}`);
          } else {
            status = 'error';
            log('error', `[workbook-sync] run=${runId} site=${source.site_id} ${error}`);
            throw new WorkbookDailyLayoutUnreadable(error);
          }
        } else {
          // ── B1 — NEVER rewrite a day that has already been invoiced ─────────
          // Only the grace path can reach a billed day: the current-month path
          // writes days inside a month nobody has closed yet. When it does happen,
          // the workbook and an invoice MRC already has now disagree, and quietly
          // moving the Vision figure would leave no trace of that disagreement —
          // it would just make Vision stop matching what was sent. The day is left
          // exactly as billed and the count is put on the ledger, because the fix
          // is a human decision (a superseding invoice), not a poller's.
          let rows = daily.rows;
          if (isGrace && rows.length > 0) {
            const billed = await billedDaysFor(
              prisma,
              source.site_id,
              rows.map((r) => r.productionDate),
            );
            if (billed.size > 0) {
              const before = rows.length;
              rows = rows.filter((r) => !billed.has(r.productionDate));
              rowsSkippedBilled = before - rows.length;
              log(
                'warn',
                `[workbook-sync] run=${runId} site=${source.site_id}${tag} ${rowsSkippedBilled} day(s) ` +
                  `left alone — already covered by an approved invoice: ${[...billed].sort().join(', ')}. ` +
                  `The workbook disagrees with an invoice that has already been sent; resolving that is a ` +
                  `human decision (supersede the invoice), not this sync's.`,
              );
            }
          }

          const counts = await prisma.$transaction((tx) =>
            upsertDailyProduction({
              db: tx,
              siteId: source.site_id,
              syncRunId: runId,
              rows,
            }),
          );
          rowsUpserted = counts.upserted;
          rowsOverwritten = counts.overwritten;
          rowsSkippedManual = counts.skippedManual;
          workbookRead = true;
          log(
            'info',
            `[workbook-sync] run=${runId} site=${source.site_id}${tag} "${fileName}" gen=${daily.templateGeneration} month=${parsed.workbookMonth ?? 'n/a'} daysSeen=${daily.daysSeen} upserted=${rowsUpserted} overwritten=${rowsOverwritten} midEdit=${rowsSkippedMidedit} skippedBilled=${rowsSkippedBilled} skippedManual=${rowsSkippedManual}`,
          );
        }
      }

      // The file watermark advances ONLY when the workbook was actually read. A
      // refusal or a skip leaves the stored cTag alone so the next poll re-reads
      // the same bytes — the deliberate D12c posture, extended to `skipped`.
      //
      // B1 — a grace poll advances ONLY the grace watermark, and never
      // `last_polled_at`: that column feeds the "is this source alive?" health
      // read, and letting a catch-up read of a finished month refresh it would
      // make a dead current-month feed look alive for the first week of every
      // month. Health is the current month's business alone.
      await prisma.workbookSource.update({
        where: { id: source.id },
        data: isGrace
          ? file && workbookRead
            ? { grace_file_id: file.id, grace_file_name: file.name, grace_file_ctag: file.ctag }
            : {}
          : {
              last_polled_at: nowFn(),
              ...(file && workbookRead
                ? { last_file_id: file.id, last_file_name: file.name, last_file_ctag: file.ctag }
                : {}),
            },
      });
    }
  } catch (err) {
    if (err instanceof FilesForbiddenError) {
      status = 'forbidden';
      error = err.message;
      log(
        'error',
        `[workbook-sync] run=${runId} site=${source.site_id} FORBIDDEN (Files.Read.All missing) — ${error}`,
      );
    } else {
      status = 'error';
      error = describe(err);
      log('error', `[workbook-sync] run=${runId} site=${source.site_id} FAILED — ${error}`);
    }
  }

  // ── ADR-0049 Am.3 A4 — health watermark, then ONE graded alarm decision ─────
  //
  // Every page in this engine used to be fired from inside the catch block, which
  // is why `not_found` — a rename, a typo, a `… (1).xlsm` copy — pages nobody, and
  // why a stuck refusal paged on its own 30-minute in-process timer. Both
  // decisions now happen HERE, once, after the outcome is settled, against durable
  // per-source state.
  //
  // B1 — a GRACE poll is excluded from both. Health first: `last_success_at` and
  // `consecutive_failures` answer "is the live feed working?", and a successful
  // read of last month's file is not evidence that this month's is being read —
  // letting it reset the counter would mask a dead current-month feed for the
  // first week of every month. And the alarm: the prior month's file gets
  // archived, renamed, or moved into a year folder as a matter of routine, so a
  // grace `not_found` is the EXPECTED end state, not a fault. Paging on it would
  // fire on every source, every month, on schedule — the textbook ADR-0037 Q1/Q2
  // failure. Grace outcomes live on the run ledger, which is where a bounded
  // catch-up read belongs.
  const paged = isGrace
    ? false
    : await recordHealthAndAlarm({
        prisma,
        source,
        status,
        error,
        now: nowFn(),
        log,
      });

  // Ledger row ALWAYS (mymrc_sync_runs discipline), including throw / fail-soft.
  try {
    await prisma.workbookSyncRun.create({
      data: {
        source_id: source.id,
        site_id: source.site_id,
        started_at: started,
        finished_at: nowFn(),
        status,
        transport_mode: mode,
        file_name: fileName,
        changes_detected: changesDetected,
        rows_upserted: rowsUpserted,
        rows_skipped_midedit: rowsSkippedMidedit,
        rows_overwritten: rowsOverwritten,
        grace_window: isGrace,
        rows_skipped_billed: rowsSkippedBilled,
        rows_skipped_manual: rowsSkippedManual,
        cutover_noop: cutoverNoop,
        error_text: error,
        run_id: runId,
      },
    });
  } catch (e) {
    log(
      'error',
      `[workbook-sync] run=${runId} site=${source.site_id} LEDGER WRITE FAILED — ${describe(e)}`,
    );
  }

  return {
    sourceId: source.id,
    siteId: source.site_id,
    status,
    transportMode: mode,
    fileName,
    changesDetected,
    cutoverNoop,
    rowsUpserted,
    rowsSkippedMidedit,
    rowsOverwritten,
    graceWindow: isGrace,
    rowsSkippedBilled,
    rowsSkippedManual,
    error,
    runId,
    paged,
  };
}

/**
 * Build the adapter's wrong-workbook cross-check (source names → owning site, via
 * `source_aliases` so spelling drift resolves).
 *
 * Returns `undefined` — check skipped — when the resolver cannot be built. An
 * unavailable resolver is NOT evidence that the file is wrong, so it must not
 * fail the run; it is logged and the sync proceeds without the cross-check.
 */
async function siteScopeFor(
  prisma: PrismaClient,
  siteId: string,
  log: SyncLogger,
): Promise<DailySiteScope | undefined> {
  try {
    return { siteId, resolver: await sourceAliasResolver(prisma) };
  } catch (e) {
    log(
      'warn',
      `[workbook-sync] site=${siteId} site-alias resolver unavailable — wrong-site cross-check SKIPPED this poll: ${describe(e)}`,
    );
    return undefined;
  }
}

// ── ADR-0049 Am.3 A4 — the health watermark and the ONE alarm decision ───────

interface HealthArgs {
  prisma: PrismaClient;
  source: WorkbookSource;
  status: SyncStatus;
  error: string | null;
  now: Date;
  log: SyncLogger;
}

/**
 * Record what this poll proved about the source's health, then decide — once —
 * whether to page. Returns whether a page was published.
 *
 * Health is a two-state fact, and the two states are NOT `ok` vs everything else:
 *
 *   HEALTHY  — the workbook was read (including a delta no-op and a legitimately
 *              empty month) or the site is cut over and no-oping by design.
 *              Stamps `last_success_at`, clears the failure streak.
 *   NOT YET  — `not_found`, `skipped`, `forbidden`, `error`. Increments the
 *              streak. NONE of these proves data arrived, and until this
 *              amendment `not_found` proved nothing AND told nobody.
 *
 * Two conditions page, both `high`, both at most once per site per 24 h:
 *
 *   1. A READ FAILURE (`error` / `forbidden`) — pages on the FIRST poll of the
 *      streak, because a 403 or a refused workbook is a real breakage and sitting
 *      on it for a day helps nobody. Then at most daily while it persists.
 *   2. STALENESS — no successful read for `STALE_AFTER_MS`, whatever the status.
 *      This is the only thing that pages on `not_found` and `skipped`, and it must
 *      be: `not_found` on the 1st of a month, before Kelsey creates the new file,
 *      is the correct and expected state (D5) and paging on it would be a monthly
 *      false alarm. A rename, a typo or a `… (1).xlsm` copy produces the SAME
 *      `not_found` — indistinguishable per-poll, distinguishable only by duration.
 *      Duration is therefore the signal.
 *
 * The 24 h gate lives in `workbook_sources.last_alert_at`, not in `ntfy.ts`'s
 * process-local cooldown Map, because that Map is wiped by every container restart
 * — which is how a stuck refusal produced ~28 identical pages per business day.
 */
async function recordHealthAndAlarm(args: HealthArgs): Promise<boolean> {
  const { prisma, source, status, error, now, log } = args;
  const healthy = status === 'ok';
  const failures = healthy ? 0 : source.consecutive_failures + 1;
  const lastSuccessAt = healthy ? now : source.last_success_at;

  const staleFor =
    lastSuccessAt === null
      ? now.getTime() - source.created_at.getTime()
      : now.getTime() - lastSuccessAt.getTime();
  const stale = !healthy && staleFor >= STALE_AFTER_MS;
  const readFailure = status === 'error' || status === 'forbidden';
  const cooledDown =
    source.last_alert_at === null ||
    now.getTime() - source.last_alert_at.getTime() >= ALERT_COOLDOWN_MS;
  const shouldPage = !healthy && ((readFailure && failures === 1) || stale) && cooledDown;

  try {
    await prisma.workbookSource.update({
      where: { id: source.id },
      data: {
        consecutive_failures: failures,
        ...(healthy ? { last_success_at: now } : {}),
        ...(shouldPage ? { last_alert_at: now } : {}),
      },
    });
  } catch (e) {
    // Never let health bookkeeping fail a poll that otherwise succeeded.
    log('warn', `[workbook-sync] site=${source.site_id} health update failed — ${describe(e)}`);
  }

  if (!shouldPage) return false;
  const days = Math.floor(staleFor / (24 * 60 * 60 * 1000));
  const headline =
    status === 'forbidden'
      ? 'Workbook sync forbidden (Files.Read.All)'
      : stale
        ? 'Workbook sync has produced no data'
        : 'Workbook sync failing';
  await publishNtfy({
    topic: 'dr3-vision-system',
    title: `${headline} — ${source.site_id}`,
    body:
      `${error ?? `status=${status}`}\n\n` +
      `Site ${source.site_id}, file pattern "${source.naming_pattern}". ` +
      `${failures} consecutive failed poll(s); last successful read ` +
      `${lastSuccessAt === null ? 'NEVER' : `${days} day(s) ago`}. ` +
      `${status === 'not_found' ? 'The file was not found — check for a rename, a typo, a stray copy, or a moved folder. ' : ''}` +
      `Nothing has been written. Next page for this site in 24h at the earliest.`,
    priority: 'high',
    tags: ['warning', 'workbook-sync', 'dr3-vision'],
    clickUrl: SYNC_CLICK_URL,
    fingerprint: `workbook-sync-${source.site_id}`,
    cooldownMs: ALERT_COOLDOWN_MS,
  }).catch((e: unknown) => {
    log('warn', `[workbook-sync] site=${source.site_id} page failed — ${describe(e)}`);
  });
  return true;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
