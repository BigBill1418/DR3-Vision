// ADR-0046 Amendment 5 (D-M5-2) — env plumbing for the Claude-API extraction
// fallback. FOUNDATION layer: reads are done at CALL TIME (not module load) so
// the values track env set after import and stay unit-testable, mirroring the
// fleet convention (src/lib/r2.ts etc. read process.env at call time). Both vars
// have safe defaults, so the app never requires them to boot; the ANTHROPIC_API_KEY
// itself lives in ~/.dr3-vision-secrets/anthropic.env (mounted required:false —
// absent → the fallback is simply disabled and low-confidence local extraction
// lands as-is for the approver to confirm manually).

/// Default model id for the extraction fallback (spec-locked, D-M5-2 §3).
export const AP_EXTRACTION_CLAUDE_MODEL_DEFAULT = 'claude-sonnet-4-6';

/// Default per-call timeout for the extraction fallback, in milliseconds
/// (spec-locked, D-M5-2 §3).
export const AP_EXTRACTION_CLAUDE_TIMEOUT_MS_DEFAULT = 30000;

/// Resolve the Claude model id for extraction. `AP_EXTRACTION_CLAUDE_MODEL`
/// overrides; a blank/unset value falls back to the spec default.
export function apExtractionClaudeModel(): string {
  const raw = process.env['AP_EXTRACTION_CLAUDE_MODEL']?.trim();
  return raw && raw.length > 0 ? raw : AP_EXTRACTION_CLAUDE_MODEL_DEFAULT;
}

/// Resolve the extraction fallback timeout in ms. `AP_EXTRACTION_CLAUDE_TIMEOUT_MS`
/// overrides; a missing, non-numeric, or non-positive value falls back to the
/// spec default.
export function apExtractionClaudeTimeoutMs(): number {
  const raw = process.env['AP_EXTRACTION_CLAUDE_TIMEOUT_MS'];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : AP_EXTRACTION_CLAUDE_TIMEOUT_MS_DEFAULT;
}

/// Whether the Claude fallback is configured at all (key present). When false the
/// pipeline must skip the fallback and keep the local result.
export function apExtractionFallbackEnabled(): boolean {
  const key = process.env['ANTHROPIC_API_KEY']?.trim();
  return !!key && key.length > 0;
}
