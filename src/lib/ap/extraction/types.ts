// ADR-0046 Amendment 5 (D-M5-2) — shared types for the intake auto-extraction
// pipeline and the variance/decide state it feeds. FOUNDATION layer: these types
// are the contract the pipeline (`src/lib/ap/extraction/pipeline.ts`, other
// agents), the decide service (`src/lib/ap/approvals.ts`), and the decide UI
// (`ApQueueClient.tsx`) all import — keep them the single source of truth for the
// `ap_requests.extraction` JSON shape.

/// Confidence tier of an extracted invoice amount (D-M5-2 §2 scoring).
/// - `high`:   one distinct canonical Total/Amount-Due/Balance-Due/Grand-Total
///             match, agreeing with any repeated Total line.
/// - `medium`: single match but multiple candidates exist, or a single
///             non-canonical pattern match.
/// - `low`:    multiple canonical matches disagree, or only bare amounts found.
/// - `failed`: no dollar amounts extracted at all (scanned image w/o OCR, empty).
export type ExtractionConfidence = 'high' | 'medium' | 'low' | 'failed';

/// Which stage produced the winning result. `local` = pdf-parse + regex
/// heuristics; `claude_api` = the Anthropic fallback (fired only on local
/// low/failed).
export type ExtractionSource = 'local' | 'claude_api';

/// One candidate amount seen anywhere in the document, retained for
/// disambiguation + the approver's context. `source_hint` names where it came
/// from (e.g. "Total Due line", "email body", "attachment: invoice.pdf p2").
export interface ExtractionCandidate {
  amount_cents: number;
  source_hint: string;
}

/// The full extraction result persisted to `ap_requests.extraction` (JSONB) at
/// intake. Pre-fills the decide panel; the approver ALWAYS confirms every field
/// (never auto-applied — hard rule #5). On outright failure the row still lands
/// with `confidence: 'failed'`, `best_amount_cents: null`, and (when a fallback
/// was attempted and threw) `error` populated — extraction NEVER blocks the poll.
export interface ExtractionResult {
  /// Best-guess total in integer cents; null when nothing could be extracted.
  best_amount_cents: number | null;
  /// Best-guess vendor name; null when none inferred.
  best_vendor: string | null;
  confidence: ExtractionConfidence;
  source: ExtractionSource;
  /// Every distinct candidate amount found (may be empty).
  candidates: ExtractionCandidate[];
  /// ISO-8601 timestamp of the extraction attempt.
  attempted_at: string;
  /// Anthropic model id, present only when `source === 'claude_api'`.
  model?: string;
  /// Estimated Claude-fallback cost in cents, for per-invoice observability.
  cost_cents?: number;
  /// Populated only when the fallback path threw (timeout, transport, parse).
  error?: string;
}

/// Mirrors the Prisma `ApVarianceFlagState` enum (schema.prisma) for use in
/// server/UI code that hasn't imported the generated client type. Keep in lockstep
/// with the enum + the `ap_requests.variance_flag_state` column.
/// - `not_applicable`: not a site Approve, or vendor has no ESTABLISHED baseline.
/// - `below_threshold`: baseline exists, amount within bounds — Approve flows.
/// - `above_threshold`: baseline exists, amount trips a threshold — Approve BLOCKED
///                      until acknowledged.
/// - `acknowledged`: approver acknowledged the variance — Approve unblocked.
export type ApVarianceFlagState =
  | 'not_applicable'
  | 'below_threshold'
  | 'above_threshold'
  | 'acknowledged';

/// Provenance of an `ap_vendor_baseline_history` row — mirrors the Prisma
/// `ApBaselineHistorySource` enum.
export type ApBaselineHistorySource = 'bill_upload' | 'vision_approval';

/// Equipment/asset category — mirrors the Prisma `EquipmentCategory` enum.
export type EquipmentCategory = 'vehicle' | 'forklift' | 'baler' | 'terex' | 'other';
