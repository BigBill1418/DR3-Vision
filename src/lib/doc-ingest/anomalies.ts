// ADR-0067 D9 / §3.2 D7 — the anomaly ledger's write path.
//
// ── Why this file exists at all ─────────────────────────────────────────────
// `doc_ingest_anomalies` dedups on `fingerprint` behind a PARTIAL unique index
// (`WHERE status = 'open'`). Prisma cannot express a partial unique index, so
// `@@unique([fingerprint])` is deliberately ABSENT from the model — which means
// **a bare `upsert` does not work**: Prisma has no unique selector to upsert on,
// and even a hand-rolled find-then-write races two concurrent sweeps into a
// unique violation.
//
// So the raise is written once, here, as: find the OPEN row → bump it, or insert
// → and if the insert loses the race (P2002 on the partial index), fall back to
// the bump. Concurrency-safe without a lock, and callers cannot get it wrong
// because there is nothing for them to get wrong.
//
// Resolved rows with the same fingerprint are RETAINED and are allowed to
// coexist — they are the evidence that a thing was wrong and got fixed. Only one
// row may be OPEN.
//
// ── Paging policy ───────────────────────────────────────────────────────────
// Not every anomaly pages. ADR-0037's 5-question gate is applied per KIND in
// `ANOMALY_POLICY` below, and the ledger for the cooldown is the DB column
// `last_paged_at`, never `publishNtfy`'s in-process cache — the same reasoning
// as `reauth_paged_at`: an in-process ledger either re-pages on every container
// restart or suppresses the FIRST page after one.

import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  DocIngestAnomaly,
  DocIngestAnomalyKind,
  DocIngestAnomalySeverity,
} from '@prisma/client';
import { publishNtfy } from '@/lib/ntfy';
import { CONNECT_PAGE_PATH } from './reauth';

/** System-level topic. ntfy is Bill-only + system events (CLAUDE.md hard rule #5). */
const NTFY_TOPIC = 'dr3-vision-system';

/** Where an operator goes to act on an anomaly. Tier-1 click target (ADR-0036). */
export const ANOMALIES_PAGE_PATH = '/admin/doc-ingest/anomalies';
export const SOURCES_PAGE_PATH = '/admin/doc-ingest';
export const HEALTH_PAGE_PATH = '/admin/doc-ingest/health';
/** ADR-0069 — where an operator sees what absorption produced (or did not). */
export const RECONCILIATION_PAGE_PATH = '/admin/doc-ingest/reconciliation';

/** How often an UNRESOLVED anomaly re-pages. The transition always pages. */
export const ANOMALY_REPAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface AnomalyPolicy {
  severity: DocIngestAnomalySeverity;
  /** null ⇒ never pages; it is a dashboard tile, per ADR-0037's "below default". */
  priority: 'default' | 'high' | 'urgent' | null;
  /** Which surface answers "what do I do about this". */
  page: string;
}

/**
 * Per-kind grading against ADR-0037's 5-question gate.
 *
 * The gate's third question — "has the system tried to self-heal first?" — is
 * why nothing here is `urgent`. Every one of these conditions is internal
 * operations, not customer-visible, and the sweep is already retrying whatever
 * can be retried. `urgent` is reserved for waking Bill at 3 a.m.; a document
 * that will still be stale at 8 a.m. does not qualify.
 *
 * `unclassified` deliberately does NOT page. Bill pre-registers nothing, so the
 * unknown path is the NORMAL path for a newly shared document — paging on it
 * would page on every single share, and the confirm queue on
 * /admin/doc-ingest is exactly the dashboard tile ADR-0037 prescribes instead.
 */
const ANOMALY_POLICY: Record<DocIngestAnomalyKind, AnomalyPolicy> = {
  // ── Access + existence ────────────────────────────────────────────────────
  // A share lapsing is the silent-stop failure mode this whole ADR exists to
  // prevent, so it pages even though nothing is "broken".
  access_denied: { severity: 'critical', priority: 'high', page: SOURCES_PAGE_PATH },
  owner_lost: { severity: 'critical', priority: 'high', page: SOURCES_PAGE_PATH },
  // A deleted file is a fact, not an emergency: last-known state is retained and
  // the surface shows it. Same-day is fine.
  source_disappeared: { severity: 'warning', priority: 'default', page: SOURCES_PAGE_PATH },

  // ── Push-path health. The SWEEP covers correctness, so these are latency
  // problems, not data problems — reported, never alarming.
  subscription_expired: { severity: 'warning', priority: 'default', page: HEALTH_PAGE_PATH },
  subscription_renew_failed: { severity: 'warning', priority: 'default', page: HEALTH_PAGE_PATH },
  webhook_validation_failed: { severity: 'warning', priority: 'default', page: HEALTH_PAGE_PATH },
  // A resync is self-healing (full re-enumeration follows immediately).
  delta_token_invalid: { severity: 'info', priority: null, page: HEALTH_PAGE_PATH },

  // ── The sweep itself. This one MUST page: the sweep is the correctness
  // guarantee, and a silently dead sweep is the ADR-0057 D9 / MyMRC failure.
  sweep_failed: { severity: 'critical', priority: 'high', page: HEALTH_PAGE_PATH },
  reauth_required: { severity: 'critical', priority: 'high', page: CONNECT_PAGE_PATH },

  // ── Content acquisition ───────────────────────────────────────────────────
  download_failed: { severity: 'warning', priority: 'default', page: SOURCES_PAGE_PATH },
  checksum_mismatch: { severity: 'critical', priority: 'high', page: ANOMALIES_PAGE_PATH },
  // Oversize PAGES rather than silently truncating — a truncated workbook parses
  // fine and produces wrong billing numbers.
  oversize: { severity: 'critical', priority: 'high', page: SOURCES_PAGE_PATH },
  // Password-protected: paged ONCE, then latched on the source so it is never
  // retried in a loop.
  unreadable: { severity: 'critical', priority: 'high', page: SOURCES_PAGE_PATH },

  // ── Classification ────────────────────────────────────────────────────────
  // The queue IS the surface. Never pages. See the note above.
  unclassified: { severity: 'info', priority: null, page: SOURCES_PAGE_PATH },
  // A vendor invoice arrived at the wrong address. Worth telling someone once —
  // it is sitting somewhere nobody is processing it.
  misdirected_document: { severity: 'warning', priority: 'default', page: SOURCES_PAGE_PATH },
  // Files exist below the traversal limit that Vision is NOT watching. Quiet
  // would be the wrong answer; alarming would too.
  depth_limit_reached: { severity: 'warning', priority: 'default', page: SOURCES_PAGE_PATH },
  // Documents Vision can READ but is not WATCHING (ADR-0080). Graded exactly like
  // `depth_limit_reached`, and for the same reason: it means files exist that are
  // not being watched. `default` rather than `high` because nothing is broken and
  // nothing is degrading — the answer is a human deciding whether a document
  // belongs in the pipeline, which is a same-day question, not an hour-one one.
  // It routes to the SOURCES page because that is where registering one happens.
  discovery_gap: { severity: 'warning', priority: 'default', page: SOURCES_PAGE_PATH },

  // ── D7 guardrail. Real money and real inventory counts. These STAGE a change
  // rather than let it flow, so a human must act before the numbers move.
  aggregate_variance: { severity: 'critical', priority: 'high', page: ANOMALIES_PAGE_PATH },
  column_nulled: { severity: 'critical', priority: 'high', page: ANOMALIES_PAGE_PATH },
  row_count_drop: { severity: 'critical', priority: 'high', page: ANOMALIES_PAGE_PATH },
  parse_broken: { severity: 'critical', priority: 'high', page: ANOMALIES_PAGE_PATH },

  // ── ADR-0069 absorption ───────────────────────────────────────────────────
  // A confirmed absorbable document with no site. It cannot absorb until a human
  // picks the site, so the confirm queue is where the fix happens. It does NOT
  // page: the action is "open the queue and finish confirming", which is exactly
  // the dashboard-tile case ADR-0037 prescribes over a notification.
  absorption_refused: { severity: 'warning', priority: null, page: SOURCES_PAGE_PATH },
  // The extractor ran and produced ZERO rows. This one is graded ABOVE the
  // guardrail conditions in importance even though it does not page: a silent
  // zero is the exact failure this whole module keeps re-learning (a null ctag
  // read as "unchanged", a missing baseline read as "no variance", a failed
  // archive read as "applied"). It cannot page under the ADR-0037 gate — the fix
  // is a code change to the row adapter, not a 5-minute operator action — so it
  // is `default`: same-day, visible, and never silent.
  absorption_empty: { severity: 'critical', priority: 'default', page: RECONCILIATION_PAGE_PATH },
};

export function anomalyPolicy(kind: DocIngestAnomalyKind): AnomalyPolicy {
  return ANOMALY_POLICY[kind];
}

/**
 * Build the dedup key. Stable across sweeps for the SAME condition on the SAME
 * entity, and different for anything else — that is the entire contract, and it
 * is why the subject is part of the key rather than the message text (which
 * carries counts and timestamps that would change every run and defeat dedup).
 */
export function anomalyFingerprint(kind: DocIngestAnomalyKind, subject: string): string {
  return `${kind}:${subject}`;
}

export interface RaiseAnomalyArgs {
  kind: DocIngestAnomalyKind;
  /** The entity this is about — a source id, a drive id, `sweep`, etc. */
  subject: string;
  detail: string;
  docSourceId?: string | null;
  subscriptionId?: string | null;
  docSourceVersionId?: string | null;
  context?: Record<string, unknown>;
  /** Override the per-kind default (e.g. escalate after N consecutive failures). */
  severity?: DocIngestAnomalySeverity;
  now?: Date;
}

export interface RaiseAnomalyResult {
  anomaly: DocIngestAnomaly;
  /** True when this call OPENED the anomaly rather than bumping an open one. */
  raised: boolean;
  paged: boolean;
}

/**
 * Raise (or bump) an anomaly, then page if the policy says so.
 *
 * Safe to call on every sweep: a recurring condition bumps `occurrences` and
 * `last_seen_at` on the one open row instead of growing a row-per-poll queue.
 */
export async function raiseAnomaly(
  prisma: PrismaClient,
  args: RaiseAnomalyArgs,
): Promise<RaiseAnomalyResult> {
  const now = args.now ?? new Date();
  const fingerprint = anomalyFingerprint(args.kind, args.subject);
  const policy = ANOMALY_POLICY[args.kind];
  const severity = args.severity ?? policy.severity;

  const existing = await prisma.docIngestAnomaly.findFirst({
    where: { fingerprint, status: 'open' },
  });

  let anomaly: DocIngestAnomaly;
  let raised: boolean;

  if (existing) {
    anomaly = await bump(prisma, existing.id, args, severity, now);
    raised = false;
  } else {
    try {
      anomaly = await prisma.docIngestAnomaly.create({
        data: {
          kind: args.kind,
          severity,
          status: 'open',
          fingerprint,
          detail: args.detail,
          doc_source_id: args.docSourceId ?? null,
          subscription_id: args.subscriptionId ?? null,
          doc_source_version_id: args.docSourceVersionId ?? null,
          ...(args.context ? { context: args.context as Prisma.InputJsonValue } : {}),
          occurrences: 1,
          first_seen_at: now,
          last_seen_at: now,
        },
      });
      raised = true;
    } catch (e) {
      // Lost the race to a concurrent sweep — the partial unique index did its
      // job. Fall back to the bump so the caller's outcome is identical either
      // way. Anything else is a real error and must surface.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      const winner = await prisma.docIngestAnomaly.findFirst({
        where: { fingerprint, status: 'open' },
      });
      if (!winner) throw e; // genuinely inexplicable — do not swallow it
      anomaly = await bump(prisma, winner.id, args, severity, now);
      raised = false;
    }
  }

  const paged = await maybePage(prisma, anomaly, policy, raised, now);
  return { anomaly, raised, paged };
}

async function bump(
  prisma: PrismaClient,
  id: string,
  args: RaiseAnomalyArgs,
  severity: DocIngestAnomalySeverity,
  now: Date,
): Promise<DocIngestAnomaly> {
  return prisma.docIngestAnomaly.update({
    where: { id },
    data: {
      occurrences: { increment: 1 },
      last_seen_at: now,
      // Refresh the human-readable detail: the newest observation is the useful
      // one ("3 of 12 columns now empty" beats a week-old count). `first_seen_at`
      // is untouched — "since when" is the number that says whether this is new
      // or has been rotting.
      detail: args.detail,
      severity,
      ...(args.context ? { context: args.context as Prisma.InputJsonValue } : {}),
      ...(args.docSourceVersionId ? { doc_source_version_id: args.docSourceVersionId } : {}),
    },
  });
}

async function maybePage(
  prisma: PrismaClient,
  anomaly: DocIngestAnomaly,
  policy: AnomalyPolicy,
  raised: boolean,
  now: Date,
): Promise<boolean> {
  if (policy.priority === null) return false;

  const dueForRepage =
    anomaly.last_paged_at === null ||
    now.getTime() - anomaly.last_paged_at.getTime() >= ANOMALY_REPAGE_INTERVAL_MS;
  if (!raised && !dueForRepage) return false;

  await prisma.docIngestAnomaly.update({
    where: { id: anomaly.id },
    data: { last_paged_at: now },
  });

  await publishNtfy({
    topic: NTFY_TOPIC,
    title: `Document ingestion — ${anomaly.kind.replace(/_/g, ' ')}`,
    body: anomaly.detail,
    priority: policy.priority,
    tags: ['doc-ingest', anomaly.kind, 'dr3-vision'],
    clickUrl: absoluteUrl(policy.page),
    // This module owns dedup via `last_paged_at`. The in-process ledger must not
    // ALSO suppress, or a container restart silently changes paging behaviour.
    cooldownMs: 0,
  });
  return true;
}

/**
 * Resolve every OPEN anomaly matching a kind+subject. Called when the condition
 * clears — a share restored, a subscription renewed, a file readable again — so
 * a fixed problem stops showing as broken WITHOUT deleting the history.
 */
export async function resolveAnomaly(
  prisma: PrismaClient,
  kind: DocIngestAnomalyKind,
  subject: string,
  note: string,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.docIngestAnomaly.updateMany({
    where: { fingerprint: anomalyFingerprint(kind, subject), status: 'open' },
    data: { status: 'resolved', resolved_at: now, resolved_by: 'system', resolution_note: note },
  });
  return count;
}

/** Operator-driven resolution from `/admin/doc-ingest/anomalies`. */
export async function resolveAnomalyById(
  prisma: PrismaClient,
  id: string,
  actorUserId: string,
  note: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.docIngestAnomaly.update({
    where: { id },
    data: { status: 'resolved', resolved_at: now, resolved_by: actorUserId, resolution_note: note },
  });
}

/**
 * Acknowledge without resolving: "I have seen this, it is not fixed."
 *
 * This is what stops the re-page while keeping the anomaly visibly OPEN-ish on
 * the surface. It also frees the partial unique index, so a genuinely NEW
 * occurrence of the same condition can open a fresh row rather than silently
 * bumping a counter nobody is watching any more.
 */
export async function acknowledgeAnomaly(
  prisma: PrismaClient,
  id: string,
  actorUserId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.docIngestAnomaly.update({
    where: { id },
    data: { status: 'acknowledged', resolved_by: actorUserId, resolved_at: now },
  });
}

function absoluteUrl(path: string): string {
  const base = process.env['NEXTAUTH_URL']?.trim() || 'https://dr3-vision.svdp.us';
  return `${base.replace(/\/+$/, '')}${path}`;
}
