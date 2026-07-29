// ADR-0067 §3.2 D5 — persisting a classification proposal and confirming it.
//
// The state machine has exactly three positions and one legal transition:
//
//   unclassified   doc_class IS NULL, no proposal          → classify
//   proposed       doc_class IS NULL, proposal present     → confirm
//   registered     doc_class IS NOT NULL                   → (locked)
//
// `doc_class IS NOT NULL` IS the lock. There is deliberately no separate
// `confirmed` boolean: a boolean is a second source of truth that can disagree
// with the column it describes, and the first time it did, the pipeline would
// either re-ask a settled question or skip an unsettled one.

import type { PrismaClient, DocSource } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import {
  classifyDocument,
  VENDOR_INVOICE_CORRECT_ADDRESS,
  type ClassifyDeps,
  type DocKind,
} from './classifier';
import { summaryFromJson } from './parse';
import { raiseAnomaly, resolveAnomaly } from './anomalies';
import { sourceKey } from './discovery';

/**
 * Classify a source that has not been confirmed yet.
 *
 * Returns false without doing anything when `doc_class` is already set. That
 * early return is the DO-NOT made mechanical: "once he confirms, the kind is
 * registered and stable; never re-ask."
 */
export async function classifySourceIfNeeded(
  prisma: PrismaClient,
  source: DocSource,
  deps: ClassifyDeps = {},
  now: Date = new Date(),
): Promise<boolean> {
  if (source.doc_class !== null) return false;

  const latest = await prisma.docSourceVersion.findFirst({
    where: { doc_source_id: source.id },
    orderBy: { observed_at: 'desc' },
    select: { parse_summary: true, observed_at: true },
  });

  // ── Refuse to classify from nothing (2026-07-29 regression) ───────────────
  // A `file` source with NO version row has not been fetched yet — the sweep
  // creates the version, and it used to run AFTER this call. Classifying here
  // asks the model to judge a document it has not been shown, and a model asked
  // to judge nothing answers confidently about nothing: TEREX.xlsx came back
  // `unknown` (0.1) with "the workbook is completely empty" while its own stored
  // summary recorded 40 sheets and 2,117 rows. Defer instead — the sweep
  // re-attempts immediately after ingest.
  //
  // A FOLDER never has a version row and is classified from its name alone, so
  // the guard is scoped to files.
  if (source.kind === 'file' && latest === null) return false;

  // ── Do not re-ask a settled question every 15 minutes ─────────────────────
  // Without this, every unconfirmed source burns one Claude call per sweep
  // (~96/day each) and silently overwrites its own proposal with a fresh guess.
  // A proposal is stale only when NEW CONTENT has landed since it was made.
  if (
    source.proposed_class !== null &&
    source.classification_attempted_at !== null &&
    (latest === null || latest.observed_at <= source.classification_attempted_at)
  ) {
    return false;
  }

  const { classification, error } = await classifyDocument(
    {
      filename: source.display_name,
      pathHint: source.path_hint,
      contentType: source.content_type,
      summary: latest ? summaryFromJson(latest.parse_summary) : null,
    },
    deps,
  );

  // Resolve the proposed site NAME to an id. A name that matches nothing stays
  // NULL — hard rule #2: an unresolved site is UNCLASSIFIED, never a guess, and
  // must not leak into a site-scoped list.
  const site = classification.site
    ? await prisma.site.findFirst({
        where: { name: { equals: classification.site, mode: 'insensitive' } },
        select: { id: true },
      })
    : null;

  await prisma.docSource.update({
    where: { id: source.id },
    data: {
      proposed_class: classification.kind,
      proposed_site_id: site?.id ?? null,
      proposed_period: classification.period,
      proposed_confidence: classification.confidence,
      proposed_reasoning: classification.reasoning,
      proposed_source: classification.source,
      classification_attempted_at: now,
      classification_error: error,
    },
  });

  const subject = sourceKey(source.drive_id, source.item_id);

  // A vendor invoice does not belong here. Flagging it — and NAMING where it
  // should have gone — is the difference between a document that gets
  // redirected and one that sits in a queue nobody processes.
  if (classification.kind === 'vendor_invoice') {
    await raiseAnomaly(prisma, {
      kind: 'misdirected_document',
      subject,
      docSourceId: source.id,
      detail:
        `"${source.display_name}" looks like a vendor invoice. Vendor invoices are NOT routed by document ` +
        `ingestion — they belong in the AP approval mailbox at ${VENDOR_INVOICE_CORRECT_ADDRESS} (ADR-0046), ` +
        `where they get an approver, a second approval and a decision record. Nothing has been ingested from ` +
        `it. Ask ${source.owner_upn ?? 'the sender'} to email it to ${VENDOR_INVOICE_CORRECT_ADDRESS} instead.`,
      context: { proposedClass: classification.kind, confidence: classification.confidence },
      now,
    });
    return true;
  }

  // `unknown` is the NORMAL path for a newly shared document, so it is a queue
  // item and not a page — see the policy note in anomalies.ts.
  if (classification.kind === 'unknown') {
    await raiseAnomaly(prisma, {
      kind: 'unclassified',
      subject,
      docSourceId: source.id,
      detail:
        `"${source.display_name}" could not be classified automatically: ${classification.reasoning} ` +
        `It is waiting for confirmation at /admin/doc-ingest. Nothing is ingested from an unconfirmed source.`,
      context: { confidence: classification.confidence },
      now,
    });
  } else {
    // A later pass landed a real kind. The open `unclassified` anomaly is now a
    // false statement about a document the system HAS classified, and nothing
    // else resolves it — `confirmClassification` only runs when Bill confirms,
    // which he will not do while the surface tells him the file is empty. Two
    // surfaces disagreeing about the same document is the failure mode; close
    // the stale one here.
    await resolveAnomaly(
      prisma,
      'unclassified',
      subject,
      `Re-classified as ${classification.kind} (confidence ${classification.confidence.toFixed(2)}) once the parsed content was available.`,
      now,
    );
  }

  return true;
}

export interface ConfirmClassificationArgs {
  sourceId: string;
  kind: DocKind;
  siteId: string | null;
  period: string | null;
  actorUserId: string;
  now?: Date;
}

/**
 * Confirm (or correct) a classification. THE registering act.
 *
 * Refuses to overwrite an already-registered kind. Correcting a mistake is a
 * deliberate, separate action (`reclassifySource`) so that a stray double-submit
 * on the confirm queue can never silently re-register a document under a
 * different kind — which would change what downstream code does with it, with
 * no trace of a decision having been made.
 */
export async function confirmClassification(
  prisma: PrismaClient,
  args: ConfirmClassificationArgs,
): Promise<DocSource> {
  const now = args.now ?? new Date();
  const source = await prisma.docSource.findUniqueOrThrow({ where: { id: args.sourceId } });

  if (source.doc_class !== null) {
    throw new Error(
      `"${source.display_name}" is already registered as "${source.doc_class}". Use reclassify to change it.`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.docSource.update({
      where: { id: args.sourceId },
      data: {
        doc_class: args.kind,
        doc_class_source: 'operator',
        classified_at: now,
        classified_by: args.actorUserId,
        site_id: args.siteId,
        period: args.period,
      },
    });
    await writeAudit(
      {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: 'doc_sources',
        row_id: args.sourceId,
        before: {
          doc_class: null,
          site_id: source.site_id,
          period: source.period,
          proposed_class: source.proposed_class,
          proposed_site_id: source.proposed_site_id,
          proposed_confidence: source.proposed_confidence,
        },
        after: {
          doc_class: args.kind,
          site_id: args.siteId,
          period: args.period,
          doc_class_source: 'operator',
        },
      },
      { tx },
    );
    return row;
  });

  await resolveAnomaly(
    prisma,
    'unclassified',
    sourceKey(source.drive_id, source.item_id),
    `Confirmed as ${args.kind}.`,
    now,
  );
  return updated;
}

/**
 * Change an already-registered classification.
 *
 * Separate from `confirmClassification` on purpose: this one is a correction of
 * a settled decision, it is audited as such, and it is the only path that can
 * move a registered kind. D5 permits re-classification on a material structure
 * change — which arrives as a `parse_broken` anomaly, not as a fresh question.
 */
export async function reclassifySource(
  prisma: PrismaClient,
  args: ConfirmClassificationArgs & { reason: string },
): Promise<DocSource> {
  const now = args.now ?? new Date();
  const source = await prisma.docSource.findUniqueOrThrow({ where: { id: args.sourceId } });

  return prisma.$transaction(async (tx) => {
    const row = await tx.docSource.update({
      where: { id: args.sourceId },
      data: {
        doc_class: args.kind,
        doc_class_source: 'operator',
        classified_at: now,
        classified_by: args.actorUserId,
        site_id: args.siteId,
        period: args.period,
      },
    });
    await writeAudit(
      {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: 'doc_sources',
        row_id: args.sourceId,
        before: {
          doc_class: source.doc_class,
          site_id: source.site_id,
          period: source.period,
          classified_at: source.classified_at,
        },
        after: {
          doc_class: args.kind,
          site_id: args.siteId,
          period: args.period,
          reason: args.reason,
        },
      },
      { tx },
    );
    return row;
  });
}

/** Bill's kill switch. Separate from `state`, which is what Microsoft says. */
export async function setSourceEnabled(
  prisma: PrismaClient,
  sourceId: string,
  enabled: boolean,
  actorUserId: string,
  now: Date = new Date(),
): Promise<void> {
  const source = await prisma.docSource.findUniqueOrThrow({ where: { id: sourceId } });
  await prisma.$transaction(async (tx) => {
    await tx.docSource.update({ where: { id: sourceId }, data: { enabled } });
    await writeAudit(
      {
        actor_user_id: actorUserId,
        action: 'update',
        table_name: 'doc_sources',
        row_id: sourceId,
        before: { enabled: source.enabled },
        after: { enabled, at: now },
      },
      { tx },
    );
  });
}
