// ADR-0046 Amendment 5 (D-M5-2 §3) — Claude-API extraction fallback. Fires ONLY
// when local confidence is LOW or FAILED (the pipeline gates that; this module
// just performs the call). Sends sanitized body + attachment text + any images
// (base64, size-capped) to Claude with a structured JSON extraction prompt, times
// out at the spec-locked budget, and logs per-invoice cost for observability.
//
// The model id (spec-locked `claude-sonnet-4-6`) and timeout come from
// ./config.ts — do NOT hard-code them here. The actual Anthropic SDK call is a
// dynamic import behind an injectable `ExtractionModelCall` seam so (a) the SDK
// never loads in the ap-poll module graph until a fallback actually runs, and
// (b) unit tests drive this with a fake model call and never touch the network.

import type Anthropic from '@anthropic-ai/sdk';
import { apExtractionClaudeModel, apExtractionClaudeTimeoutMs } from './config';

/// One decoded image to hand to the vision model. `data` is raw base64 (no data:
/// URI prefix), matching the Anthropic image block `source.data`.
export interface FallbackImage {
  media_type: string;
  data: string;
}

export interface ClaudeFallbackInput {
  bodyText: string;
  attachmentTexts: { name: string; text: string }[];
  images: FallbackImage[];
}

/// A successful structured extraction from Claude. `confidence` is the model's
/// self-report (never `failed` — that tier is a local-only outcome).
export interface ClaudeExtraction {
  amount_cents: number | null;
  vendor: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  model: string;
  cost_cents: number;
}

/// Fallback outcome: a structured extraction, or a recorded error (timeout,
/// transport, or unparseable response). Never thrown — always returned.
export type ClaudeFallbackResult = ClaudeExtraction | { error: string };

/// The injectable model-call seam. Returns the concatenated assistant text plus
/// token usage; the caller parses JSON and prices the call. Tests supply a fake.
export interface ExtractionModelCall {
  (args: {
    model: string;
    timeoutMs: number;
    system: string;
    content: Anthropic.ContentBlockParam[];
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

// claude-sonnet-4-6 list pricing (USD per 1M tokens): $3 input / $15 output.
// Expressed as cents-per-token so cost lands in integer-cents-friendly range.
const INPUT_CENTS_PER_TOKEN = 300 / 1_000_000;
const OUTPUT_CENTS_PER_TOKEN = 1500 / 1_000_000;

/// Per-image decoded-byte cap and image-count cap. Base64 decodes to ~3/4 of its
/// length; we cap on decoded size to stay well under Anthropic's ~5MB/image limit
/// and bound total request size on multi-page scans.
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_IMAGES = 10;

const SYSTEM_PROMPT =
  'You are an accounts-payable extraction assistant. From the invoice text and ' +
  'images, extract the single total invoice amount and the vendor name. Respond ' +
  'with ONLY a JSON object and no other prose.';

const USER_PROMPT =
  'Extract the total invoice amount and vendor name. Return JSON with fields: ' +
  'amount_cents (integer, the invoice total in US cents), vendor (string), ' +
  'confidence (high|medium|low), reasoning (string).\n\nInvoice content:\n';

function decodedByteLength(base64: string): number {
  // 4 base64 chars → 3 bytes, minus padding.
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function buildContent(input: ClaudeFallbackInput): Anthropic.ContentBlockParam[] {
  const textParts = [input.bodyText, ...input.attachmentTexts.map((a) => `[${a.name}]\n${a.text}`)]
    .filter((t) => t && t.trim().length > 0)
    .join('\n\n');
  const blocks: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: USER_PROMPT + (textParts || '(no extractable text)') },
  ];
  let used = 0;
  for (const img of input.images) {
    if (used >= MAX_IMAGES) break;
    if (decodedByteLength(img.data) > MAX_IMAGE_BYTES) continue;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type as never, data: img.data },
    });
    used += 1;
  }
  return blocks;
}

/// Parse Claude's response into a ClaudeExtraction (minus cost/model, added by the
/// caller). Tolerates leading/trailing prose by extracting the first JSON object.
/// Returns null on anything unparseable so the caller records an error.
function parseExtraction(text: string): Omit<ClaudeExtraction, 'model' | 'cost_cents'> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const rawAmount = obj['amount_cents'];
  const amount_cents =
    typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? Math.round(rawAmount) : null;
  const vendor = typeof obj['vendor'] === 'string' && obj['vendor'].trim() ? obj['vendor'] : null;
  const rawConf = obj['confidence'];
  const confidence: ClaudeExtraction['confidence'] =
    rawConf === 'high' || rawConf === 'medium' || rawConf === 'low' ? rawConf : 'low';
  const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '';

  return { amount_cents, vendor, confidence, reasoning };
}

/// Default model call: dynamic-import the Anthropic SDK, build a per-call client
/// pinned to the extraction timeout with retries disabled (so a single 30s budget
/// is not silently multiplied), disable thinking (cheap deterministic extraction),
/// and return text + usage. Only invoked when no test seam is supplied.
const defaultModelCall: ExtractionModelCall = async ({ model, timeoutMs, system, content }) => {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient({
    apiKey: process.env['ANTHROPIC_API_KEY'],
    timeout: timeoutMs,
    maxRetries: 0,
  });
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
};

/// Run the Claude extraction fallback. Never throws: transport/timeout/parse
/// failures come back as `{ error }`. `modelCall` defaults to the real SDK; tests
/// inject a fake.
export async function runClaudeFallback(
  input: ClaudeFallbackInput,
  modelCall: ExtractionModelCall = defaultModelCall,
): Promise<ClaudeFallbackResult> {
  const model = apExtractionClaudeModel();
  const timeoutMs = apExtractionClaudeTimeoutMs();
  try {
    const { text, inputTokens, outputTokens } = await modelCall({
      model,
      timeoutMs,
      system: SYSTEM_PROMPT,
      content: buildContent(input),
    });
    const parsed = parseExtraction(text);
    if (!parsed) return { error: 'claude_fallback_unparseable_response' };
    const cost_cents =
      inputTokens * INPUT_CENTS_PER_TOKEN + outputTokens * OUTPUT_CENTS_PER_TOKEN;
    return { ...parsed, model, cost_cents: Number(cost_cents.toFixed(4)) };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { error: `claude_fallback_failed: ${reason}` };
  }
}
