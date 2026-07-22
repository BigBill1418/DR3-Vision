// ADR-0046 Amendment 5 (D-M5-2, §3) — intake extraction orchestrator. Runs during
// `runApPoll` (inside ingestMessage, after body sanitize + attachment fetch,
// before the queue insert): the returned ExtractionResult is merged into the
// `ap_requests` row so it lands atomically. NEVER blocks or fails the poll — every
// path returns an ExtractionResult; a hard failure lands `confidence: 'failed'`
// with `error` populated. The result only ever PRE-FILLS the decide panel; the
// approver still confirms every field (hard rule #5).
//
// It does NOT populate `ap_requests.extracted_haul_numbers` — that column is a
// Phase-2 schema hook only (hard rule #2, gated on ADR-0057).

import type { NormAttachment, NormFileAttachment } from '@/lib/msgraph-mail';
import { apExtractionFallbackEnabled } from './config';
import { extractPdfText, scanTextSources, type TextSource } from './local-parser';
import {
  runClaudeFallback,
  type ClaudeFallbackInput,
  type FallbackImage,
} from './claude-fallback';
import type { ExtractionResult } from './types';

/// Everything the pipeline needs off one polled message.
export interface ExtractionSourceInput {
  bodyText: string | null;
  bodyHtmlSanitized?: string | null;
  attachments: readonly NormAttachment[];
}

/// Injectable seams (all default to the real implementations). Tests override
/// `pdfText`, `runFallback`, and `fallbackEnabled` to run offline and deterministic.
export interface ExtractionDeps {
  pdfText?: (bytes: Buffer, name: string) => Promise<string>;
  runFallback?: typeof runClaudeFallback;
  fallbackEnabled?: () => boolean;
  now?: () => Date;
  /// Called once with the fallback's per-invoice cost when a fallback runs — the
  /// caller (ap-poll) logs it for the cost-observability requirement (§D-M5-2).
  logCost?: (costCents: number, model: string) => void;
}

const PDF_NAME = /\.pdf$/i;

function isPdf(att: NormFileAttachment): boolean {
  return (att.contentType?.toLowerCase().includes('pdf') ?? false) || PDF_NAME.test(att.name ?? '');
}

function imageMediaType(att: NormFileAttachment): string | null {
  const ct = att.contentType?.toLowerCase();
  if (ct?.startsWith('image/')) return ct;
  const name = att.name ?? '';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.webp$/i.test(name)) return 'image/webp';
  return null;
}

/// Flatten the Graph attachment taxonomy to the file attachments we can read:
/// top-level `file` attachments plus the files inside one-level-unwrapped
/// `nested_message` items. Reference links are never fetched, so they carry no
/// bytes and are skipped.
function collectFiles(attachments: readonly NormAttachment[]): NormFileAttachment[] {
  const files: NormFileAttachment[] = [];
  for (const att of attachments) {
    if (att.kind === 'file') files.push(att);
    else if (att.kind === 'nested_message') files.push(...att.nestedFiles);
  }
  return files;
}

function bodySource(input: ExtractionSourceInput): string {
  if (input.bodyText && input.bodyText.trim()) return input.bodyText;
  const html = input.bodyHtmlSanitized;
  if (html && html.trim()) return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

function baseResult(
  partial: Partial<ExtractionResult> & Pick<ExtractionResult, 'confidence' | 'source'>,
  attemptedAt: string,
): ExtractionResult {
  return {
    best_amount_cents: partial.best_amount_cents ?? null,
    best_vendor: partial.best_vendor ?? null,
    confidence: partial.confidence,
    source: partial.source,
    candidates: partial.candidates ?? [],
    attempted_at: attemptedAt,
    ...(partial.model !== undefined ? { model: partial.model } : {}),
    ...(partial.cost_cents !== undefined ? { cost_cents: partial.cost_cents } : {}),
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}

/// Extract a best-guess invoice total + vendor for one polled request.
/// Hybrid, ordered (D-M5-2): local pdf-parse + regex first; Claude fallback only
/// on LOW/FAILED local confidence when a key is configured.
export async function extractFromRequest(
  input: ExtractionSourceInput,
  deps: ExtractionDeps = {},
): Promise<ExtractionResult> {
  const pdfText = deps.pdfText ?? ((bytes) => extractPdfText(bytes));
  const runFallback = deps.runFallback ?? runClaudeFallback;
  const fallbackEnabled = deps.fallbackEnabled ?? apExtractionFallbackEnabled;
  const now = deps.now ?? (() => new Date());
  const attemptedAt = now().toISOString();

  try {
    const files = collectFiles(input.attachments);

    // Gather text sources (email body + each PDF's extracted text) and images.
    const sources: TextSource[] = [{ name: 'email body', text: bodySource(input) }];
    const attachmentTexts: { name: string; text: string }[] = [];
    const images: FallbackImage[] = [];

    for (const file of files) {
      if (!file.contentBytesBase64) continue;
      const label = `attachment: ${file.name ?? file.id}`;
      if (isPdf(file)) {
        const text = await pdfText(Buffer.from(file.contentBytesBase64, 'base64'), file.name ?? '');
        if (text.trim()) {
          sources.push({ name: label, text });
          attachmentTexts.push({ name: file.name ?? file.id, text });
        }
      } else {
        const media = imageMediaType(file);
        if (media) images.push({ media_type: media, data: file.contentBytesBase64 });
      }
    }

    const local = scanTextSources(sources);

    // Fallback fires only on weak local confidence, and only if configured.
    const needsFallback = local.confidence === 'low' || local.confidence === 'failed';
    if (needsFallback && fallbackEnabled()) {
      const fbInput: ClaudeFallbackInput = {
        bodyText: sources[0]?.text ?? '',
        attachmentTexts,
        images,
      };
      const fb = await runFallback(fbInput);
      if ('error' in fb) {
        // Local FAILED + fallback error → the spec failure mode (failed, null,
        // error). Local LOW + fallback error → keep the local low pre-fill but
        // record the error so it's never silently lost.
        return baseResult(
          {
            best_amount_cents: local.best_amount_cents,
            confidence: local.confidence,
            source: 'local',
            candidates: local.candidates,
            error: fb.error,
          },
          attemptedAt,
        );
      }
      deps.logCost?.(fb.cost_cents, fb.model);
      return baseResult(
        {
          best_amount_cents: fb.amount_cents,
          best_vendor: fb.vendor,
          confidence: fb.confidence,
          source: 'claude_api',
          candidates: local.candidates,
          model: fb.model,
          cost_cents: fb.cost_cents,
        },
        attemptedAt,
      );
    }

    // Fallback disabled or local confidence already HIGH/MEDIUM: land local as-is.
    return baseResult(
      {
        best_amount_cents: local.best_amount_cents,
        confidence: local.confidence,
        source: 'local',
        candidates: local.candidates,
      },
      attemptedAt,
    );
  } catch (e) {
    // A bug in extraction must never crash the poll — degrade to failed.
    const reason = e instanceof Error ? e.message : String(e);
    return baseResult(
      { best_amount_cents: null, confidence: 'failed', source: 'local', error: reason },
      attemptedAt,
    );
  }
}
