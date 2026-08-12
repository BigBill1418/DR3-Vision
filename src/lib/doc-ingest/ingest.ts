// ADR-0067 §3.2 D6/D7 — turning an observed change into an ingested revision.
//
// One source, one revision, one decision:
//
//   ctag unchanged      → no-op (this is what makes a re-delivered notification free)
//   read blocked        → skip, without a Graph call (D8: never retry in a loop)
//   bytes → R2 → version row → parse → guardrail
//   guardrail clean     → APPLY automatically (D6), with a before/after audit row
//   guardrail tripped   → STAGE for apply-or-discard, and raise the anomaly (D7)
//
// ── Bytes go to R2. Always. ─────────────────────────────────────────────────
// CLAUDE.md hard rule #7. `doc_source_versions.r2_key` holds a KEY — never a
// blob, never a local path. When R2 is unconfigured the version row still lands
// with a null key: losing the OBSERVATION because the archive was unavailable
// would be strictly worse than losing the archive.

import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type DocSource, type DocSourceVersion } from '@prisma/client';
import { putFileDrop } from '@/lib/r2';
import { writeAudit } from '@/lib/audit';
import {
  DocIngestAccessDeniedError,
  DocIngestNotFoundError,
  DocIngestOversizeError,
  type DocIngestGraph,
} from './graph';
import { docIngestMaxFileBytes } from './pipeline-config';
import { parseDocument, summaryFromJson, summaryToJson, type ParseSummary } from './parse';
import { evaluateGuardrail } from './guardrail';
import { raiseAnomaly, resolveAnomaly } from './anomalies';
import { sourceKey } from './discovery';

/** Audit actor for anything the pipeline does on its own. */
export const DOC_INGEST_ACTOR = 'system:doc-ingest';

export type IngestOutcome =
  | 'skipped_disabled'
  | 'skipped_folder'
  | 'skipped_read_blocked'
  | 'unchanged'
  | 'applied'
  | 'staged'
  | 'failed';

export interface IngestResult {
  outcome: IngestOutcome;
  versionId: string | null;
  anomaliesRaised: number;
}

export interface IngestDeps {
  now?: Date;
  maxBytes?: number;
  /** Injected in tests so no real R2 call happens. */
  putBytes?: typeof putFileDrop;
}

/**
 * Ingest the current revision of one source.
 *
 * NEVER throws for a per-source problem — a single unreadable document must not
 * stop the sweep for every other document. Failures become anomalies, which is
 * how they stay visible.
 */
export async function ingestSource(
  prisma: PrismaClient,
  graph: DocIngestGraph,
  source: DocSource,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const now = deps.now ?? new Date();
  const maxBytes = deps.maxBytes ?? docIngestMaxFileBytes();
  const put = deps.putBytes ?? putFileDrop;
  const subject = sourceKey(source.drive_id, source.item_id);

  // Bill's kill switch. `enabled` is what Bill says; `state` is what Microsoft
  // says. Never conflated — a disabled source is still tracked, just not read.
  if (!source.enabled) return { outcome: 'skipped_disabled', versionId: null, anomaliesRaised: 0 };
  if (source.kind === 'folder')
    return { outcome: 'skipped_folder', versionId: null, anomaliesRaised: 0 };

  // D8 — password-protected / unreadable: "mark, page, DO NOT retry in a loop."
  // The latch is released by discovery when the ctag changes, so a genuinely new
  // file gets exactly one more attempt and an unchanged one costs nothing.
  if (source.read_blocked_at !== null && source.read_blocked_ctag === source.ctag) {
    return { outcome: 'skipped_read_blocked', versionId: null, anomaliesRaised: 0 };
  }

  // ── A missing content marker must RECOVER, never silently stop ────────────
  // The superseded code returned `unchanged` here. The reasoning was sound as
  // far as it went — no ctag means no idempotency key, and ingesting without one
  // would append a duplicate revision every sweep forever — but it chose the
  // wrong failure direction. `unchanged` is indistinguishable from success, so a
  // source that lost its marker stopped being ingested PERMANENTLY and SILENTLY
  // while the sweep reported `ok`.
  //
  // That is not hypothetical: `applyDeltaItems` blanked the marker on every
  // delta pass (see the note there), so this branch was live on the only
  // document in the system. The two defects composed into exactly the
  // silent-staleness class ADR-0067 was written to eliminate.
  //
  // A marker is recoverable — Graph will tell us the current one — so recover
  // it. If even that fails, raise a real anomaly. Never return "nothing to do"
  // for a condition that means "I no longer know how to do this".
  let ctag = source.ctag;
  if (!ctag) {
    try {
      const fresh = await graph.getItem(source.drive_id, source.item_id);
      ctag = fresh.ctag;
      if (ctag) {
        await prisma.docSource.update({ where: { id: source.id }, data: { ctag } });
      }
    } catch {
      // fall through to the anomaly below — the recovery attempt is best-effort,
      // the alarm is not.
    }
  }
  if (!ctag) {
    const res = await raiseAnomaly(prisma, {
      kind: 'download_failed',
      subject,
      docSourceId: source.id,
      detail:
        `"${source.display_name}" has no content marker (ctag), so Vision cannot tell whether it has ` +
        `changed and is NOT ingesting it. This is not "unchanged" — it is "unknown". Microsoft did not ` +
        `supply a marker and a direct re-read did not recover one.`,
      context: { driveId: source.drive_id, itemId: source.item_id },
      now,
    });
    return { outcome: 'failed', versionId: null, anomaliesRaised: res.raised ? 1 : 0 };
  }

  const existingVersion = await prisma.docSourceVersion.findUnique({
    where: { doc_source_id_ctag: { doc_source_id: source.id, ctag } },
    select: { id: true, staged: true, applied_at: true, r2_key: true },
  });
  // Already seen this exact content. This single check is what makes a
  // re-delivered Graph notification, a webhook retry and a scheduled sweep all
  // converge on the same state instead of stacking duplicates.
  if (existingVersion) {
    // ── ADR-0098 §3 — clear a healed `download_failed` HERE too ─────────────
    // ADR-0095 moved this resolve above the guardrail branch, which fixed the
    // staged-revision case but left the far more common one: this early return.
    // A source that 503'd once and then downloaded cleanly keeps an OPEN
    // `download_failed` for as long as its content does not change again,
    // re-paging every 24h about a failure that healed in fifteen minutes.
    // TEREX.xlsx sat in exactly that state from 16:58 PT on 2026-08-11.
    //
    // Reaching this line means the live content marker matches a revision we
    // have already archived — "my copy of this document is current", which is a
    // STRONGER claim than "a download succeeded" and squarely resolves the
    // condition. The `r2_key` guard matters: a revision whose archive write
    // failed is one `applyVersion` raises `download_failed` FOR, so clearing it
    // here would put the two into a resolve/raise loop and assert we hold bytes
    // we do not.
    if (existingVersion.r2_key) {
      await resolveAnomaly(
        prisma,
        'download_failed',
        subject,
        'Content marker matches an archived revision — the current copy is held.',
        now,
      );
    }
    return { outcome: 'unchanged', versionId: existingVersion.id, anomaliesRaised: 0 };
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────
  let bytes: Uint8Array;
  try {
    bytes = await graph.downloadItem(source.drive_id, source.item_id, maxBytes);
  } catch (e) {
    return {
      outcome: 'failed',
      versionId: null,
      anomaliesRaised: await recordFetchFailure(prisma, source, subject, e, ctag, maxBytes, now),
    };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // ── Archive to R2 (hard rule #7) ─────────────────────────────────────────
  let r2Key: string | null = null;
  try {
    r2Key = await put({
      id: `doc-source-${source.id}-${sha256.slice(0, 12)}`,
      filename: source.display_name,
      contentType: source.content_type,
      bytes,
    });
  } catch {
    // Deliberately swallowed. The version row below is the OBSERVATION; the R2
    // object is the evidence. Losing the observation because the archive was
    // briefly unavailable would be the worse of the two failures by far.
    r2Key = null;
  }

  // ── Version row ───────────────────────────────────────────────────────────
  let version: DocSourceVersion;
  try {
    version = await prisma.docSourceVersion.create({
      data: {
        doc_source_id: source.id,
        ctag,
        etag: source.etag,
        size_bytes: bytes.byteLength <= 2_147_483_647 ? bytes.byteLength : null,
        last_modified_at: source.last_modified_at,
        r2_key: r2Key,
        content_sha256: sha256,
        observed_at: now,
        fetched_at: now,
      },
    });
  } catch (e) {
    // Another sweep beat us to this exact ctag. The unique index did its job;
    // the outcome is the same either way.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { outcome: 'unchanged', versionId: null, anomaliesRaised: 0 };
    }
    throw e;
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  const parsed = await parseDocument(bytes, source.display_name, source.content_type);

  if (!parsed.ok && parsed.reason === 'password_protected') {
    await prisma.docSourceVersion.update({
      where: { id: version.id },
      data: { parse_error: parsed.message },
    });
    // Latch. This is the "do not retry in a loop" guarantee, and it is a stored
    // fact rather than an in-memory one so a container restart cannot undo it.
    await prisma.docSource.update({
      where: { id: source.id },
      data: { read_blocked_at: now, read_blocked_reason: parsed.message, read_blocked_ctag: ctag },
    });
    const res = await raiseAnomaly(prisma, {
      kind: 'unreadable',
      subject,
      docSourceId: source.id,
      docSourceVersionId: version.id,
      detail:
        `"${source.display_name}" is password-protected and cannot be read: ${parsed.message} ` +
        `Vision has stopped attempting it and will not try again until the file's contents change. ` +
        `Ask ${source.owner_upn ?? 'the owner'} to share an unprotected copy.`,
      context: { reason: parsed.reason },
      now,
    });
    return { outcome: 'failed', versionId: version.id, anomaliesRaised: res.raised ? 1 : 0 };
  }

  const summary: ParseSummary | null = parsed.ok ? parsed.summary : null;
  if (summary) {
    await prisma.docSourceVersion.update({
      where: { id: version.id },
      data: { parse_summary: summaryToJson(summary) },
    });
  } else if (!parsed.ok) {
    await prisma.docSourceVersion.update({
      where: { id: version.id },
      data: { parse_error: parsed.message },
    });
  }

  // ── Guardrail ─────────────────────────────────────────────────────────────
  // The baseline is the last APPLIED revision, not merely the last observed one.
  // Comparing against a staged revision would let a rejected change silently
  // become the new normal — the next change would be measured from numbers a
  // human explicitly refused.
  // ── The guardrail baseline (hardened 2026-07-30) ──────────────────────────
  // Previously this took the SINGLE most recent applied version. If that one row
  // happened to carry a null `parse_summary` — which happens for an unsupported
  // format on an unconfirmed source, and for an operator-applied `parse_broken`
  // revision — the guardrail received no baseline, returned CLEAN, and auto-applied.
  // From then on EVERY later revision picked that same summary-less row and did the
  // same thing: variance detection silently switched off for that document,
  // permanently, with no anomaly and nothing on any surface saying so.
  //
  // Now: walk back to the most recent applied revision that actually HAS a
  // comparable summary. A baseline that is merely older is vastly better than no
  // baseline at all, because "no baseline" reads as "nothing changed".
  const previousCandidates = await prisma.docSourceVersion.findMany({
    where: { doc_source_id: source.id, applied_at: { not: null }, id: { not: version.id } },
    orderBy: { applied_at: 'desc' },
    select: { parse_summary: true },
    take: 25,
  });
  const previous =
    previousCandidates.find((p) => summaryFromJson(p.parse_summary) !== null) ?? null;

  const verdict = evaluateGuardrail({
    previous: previous ? summaryFromJson(previous.parse_summary) : null,
    next: summary ?? { format: 'text', sheets: [], totalRows: 0, textSample: '' },
    registeredKind: source.doc_class,
    // An unsupported format is not a broken document — a PDF that carries no
    // extractable structure still ingests fine. Only a source with a REGISTERED
    // classification can fail to parse *as* that classification.
    parsed: parsed.ok || (source.doc_class === null && parsed.reason === 'unsupported'),
    parseError: parsed.ok ? null : parsed.message,
  });

  // The download demonstrably succeeded — we are holding `bytes` and a parsed
  // revision. Resolve here, ABOVE the guardrail branch, not after `applyVersion`.
  //
  // It used to sit on the applied path only, so a source that recovered from a
  // download failure but whose new revision the guardrail STAGED never cleared
  // its `download_failed` row. The anomaly stayed open on a source that was
  // downloading perfectly, and re-paged every 24h forever. TEREX.xlsx hit exactly
  // that on 2026-08-11: a Graph 503 at 16:58, a clean download at 17:13 whose
  // revision staged on an aggregate variance, and an open `download_failed`
  // afterwards. Whether a revision APPLIES is a guardrail decision about content;
  // whether it DOWNLOADED is not, and one must not gate the other.
  await resolveAnomaly(prisma, 'download_failed', subject, 'Download succeeded.');

  if (verdict.stage) {
    const reason = verdict.findings.map((f) => f.detail).join(' ');
    await prisma.docSourceVersion.update({
      where: { id: version.id },
      data: { staged: true, staged_reason: reason },
    });
    let raised = 0;
    for (const finding of verdict.findings) {
      const res = await raiseAnomaly(prisma, {
        kind: finding.kind,
        // Per SOURCE and per KIND, not per version: a workbook whose totals drift
        // every week should bump one anomaly, not open a new one each time.
        subject: `${subject}:${finding.kind}`,
        docSourceId: source.id,
        docSourceVersionId: version.id,
        detail: `"${source.display_name}" — ${finding.detail} This revision is STAGED and has NOT been applied.`,
        context: finding.context,
        now,
      });
      if (res.raised) raised += 1;
    }
    return { outcome: 'staged', versionId: version.id, anomaliesRaised: raised };
  }

  await applyVersion(prisma, source, version, bytes.byteLength, DOC_INGEST_ACTOR, now, 'auto');
  return { outcome: 'applied', versionId: version.id, anomaliesRaised: 0 };
}

/**
 * Mark a revision applied, materialize it on `/admin/file-drop`, and write the
 * before/after audit row.
 *
 * D7 is explicit: EVERY auto-applied change writes a full before/after
 * `audit_log` entry. The audit is written in the SAME transaction as the state
 * change, so there is no window in which a revision is applied but unaudited
 * (the append-only audit trail is hard rule #6 — it is the record of record).
 */
export async function applyVersion(
  prisma: PrismaClient,
  source: DocSource,
  version: DocSourceVersion,
  byteSize: number,
  actorUserId: string,
  now: Date,
  // ADR-0077 — `system` is a NAMED non-human caller: unlike `auto` (which
  // credits the sweep's own DOC_INGEST_ACTOR) it audits under the label the
  // caller passes, so a one-off run says which run it was rather than
  // impersonating the pipeline. Unlike `operator` it writes no `users.id`.
  mode: 'auto' | 'operator' | 'system',
): Promise<void> {
  // ── A missing archive is a missing DOCUMENT, and it must be loud ───────────
  // `parse_summary` retains no cell values (only shape + per-header sums), so the
  // R2 object is the ONLY place this revision's content exists. The observation is
  // still recorded — losing it because the archive blipped would be worse — but
  // the inbox row that results has nothing behind it, and clicking Download 409s.
  // Previously that was the only symptom, and only if somebody clicked.
  if (!version.r2_key) {
    await raiseAnomaly(prisma, {
      kind: 'download_failed',
      subject: sourceKey(source.drive_id, source.item_id),
      docSourceId: source.id,
      docSourceVersionId: version.id,
      detail:
        `"${source.display_name}" was observed and recorded, but its bytes were NOT archived — so the ` +
        `content of this revision cannot be retrieved. The stored summary keeps only column totals, not ` +
        `cell values, so there is no other copy. Check the R2 configuration; the document needs to be ` +
        `re-ingested once storage is available.`,
      context: { versionId: version.id, ctag: version.ctag },
      now,
    });
  }

  const previous = await prisma.docSourceVersion.findFirst({
    where: { doc_source_id: source.id, applied_at: { not: null }, id: { not: version.id } },
    orderBy: { applied_at: 'desc' },
    select: { id: true, ctag: true, content_sha256: true, parse_summary: true, applied_at: true },
  });

  await prisma.$transaction(async (tx) => {
    const drop = await tx.fileDrop.create({
      data: {
        original_filename: source.display_name,
        content_type: source.content_type ?? 'application/octet-stream',
        byte_size: byteSize,
        // NEVER fabricate a key. This used to write
        // `pending-r2-doc-source-<id>` when the archive PUT had failed, producing
        // an inbox row that looks like a normal document and 409s the moment
        // anyone clicks Download. Since `parse_summary` retains no cell values,
        // the R2 object is the ONLY copy of the content — so a missing archive is
        // a missing document, not a missing convenience.
        r2_key: version.r2_key ?? '',
        status: 'received',
        detected_kind: source.doc_class,
        note:
          mode === 'auto'
            ? 'Ingested automatically from a shared document (ADR-0067).'
            : 'Applied from a staged shared-document revision after review.',
        uploaded_by: actorUserId,
        ingest_source: 'shared_file',
        doc_source_id: source.id,
      },
    });

    await tx.docSourceVersion.update({
      where: { id: version.id },
      data: {
        applied_at: now,
        applied_by: actorUserId,
        ingested_at: now,
        staged: false,
        file_drop_id: drop.id,
      },
    });

    await tx.docSource.update({
      where: { id: source.id },
      data: { last_ingested_at: now },
    });

    await writeAudit(
      {
        actor_label: mode === 'auto' ? DOC_INGEST_ACTOR : mode === 'system' ? actorUserId : null,
        actor_user_id: mode === 'operator' ? actorUserId : null,
        action: 'insert',
        table_name: 'doc_source_versions',
        row_id: version.id,
        before: previous
          ? {
              version_id: previous.id,
              ctag: previous.ctag,
              content_sha256: previous.content_sha256,
              applied_at: previous.applied_at,
              parse_summary: previous.parse_summary,
            }
          : null,
        after: {
          version_id: version.id,
          ctag: version.ctag,
          content_sha256: version.content_sha256,
          r2_key: version.r2_key,
          parse_summary: version.parse_summary,
          file_drop_id: drop.id,
          doc_source_id: source.id,
          doc_class: source.doc_class,
          site_id: source.site_id,
          mode,
        },
      },
      { tx },
    );
  });
}

/** Discard a staged revision. The row is RETAINED — it is the evidence of what was refused. */
export async function discardVersion(
  prisma: PrismaClient,
  versionId: string,
  actorUserId: string,
  note: string,
  now: Date = new Date(),
): Promise<void> {
  const version = await prisma.docSourceVersion.findUniqueOrThrow({ where: { id: versionId } });

  await prisma.$transaction(async (tx) => {
    await tx.docSourceVersion.update({
      where: { id: versionId },
      data: { staged: false, discarded_at: now, discarded_by: actorUserId, staged_reason: note },
    });
    await writeAudit(
      {
        actor_user_id: actorUserId,
        action: 'update',
        table_name: 'doc_source_versions',
        row_id: versionId,
        before: { staged: true, staged_reason: version.staged_reason },
        after: { staged: false, discarded_at: now, discarded_by: actorUserId, note },
      },
      { tx },
    );
  });
}

async function recordFetchFailure(
  prisma: PrismaClient,
  source: DocSource,
  subject: string,
  error: unknown,
  ctag: string,
  maxBytes: number,
  now: Date,
): Promise<number> {
  if (error instanceof DocIngestOversizeError) {
    // Latched for the same reason as the password case: re-downloading 4 GB on
    // every sweep to re-learn it is 4 GB is a self-inflicted outage.
    await prisma.docSource.update({
      where: { id: source.id },
      data: {
        read_blocked_at: now,
        read_blocked_reason: `exceeds the ${maxBytes}-byte cap`,
        read_blocked_ctag: ctag,
      },
    });
    const res = await raiseAnomaly(prisma, {
      kind: 'oversize',
      subject,
      docSourceId: source.id,
      detail:
        `"${source.display_name}" is larger than the ${(maxBytes / 1024 / 1024).toFixed(0)} MB ingestion cap ` +
        `(at least ${(error.observedBytes / 1024 / 1024).toFixed(1)} MB). It was NOT truncated and NOT ingested — ` +
        `a partially-read workbook parses cleanly and produces wrong numbers, so refusing it is the safe outcome. ` +
        `Raise DOC_INGEST_MAX_FILE_BYTES or split the document.`,
      context: { observedBytes: error.observedBytes, maxBytes },
      now,
    });
    return res.raised ? 1 : 0;
  }

  if (error instanceof DocIngestAccessDeniedError) {
    await prisma.docSource.update({
      where: { id: source.id },
      data: { state: 'access_denied', disappeared_at: now },
    });
    const res = await raiseAnomaly(prisma, {
      kind: 'access_denied',
      subject,
      docSourceId: source.id,
      detail: `Vision can no longer read the contents of "${source.display_name}"${
        source.owner_upn ? ` (shared by ${source.owner_upn})` : ''
      }. The share was most likely revoked.`,
      now,
    });
    return res.raised ? 1 : 0;
  }

  if (error instanceof DocIngestNotFoundError) {
    await prisma.docSource.update({
      where: { id: source.id },
      data: { state: 'disappeared', disappeared_at: now },
    });
    const res = await raiseAnomaly(prisma, {
      kind: 'source_disappeared',
      subject,
      docSourceId: source.id,
      detail: `"${source.display_name}" no longer exists in Microsoft. Its last known state is retained.`,
      now,
    });
    return res.raised ? 1 : 0;
  }

  const res = await raiseAnomaly(prisma, {
    kind: 'download_failed',
    subject,
    docSourceId: source.id,
    detail: `Could not download "${source.display_name}": ${
      error instanceof Error ? error.message : String(error)
    }. The next sweep will retry.`,
    now,
  });
  return res.raised ? 1 : 0;
}
