import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { getInviteByToken, saveDraft, SurveyCampaignError } from '@/lib/survey/campaigns';
import { isValidTokenShape } from '@/lib/survey/tokens';

// Free-text / JSON length caps (audit 2026-07-16 · CAPS). Public respondents
// write here, so unbounded `answer_text` / `answer_json` is a storage-DoS
// boundary. Cap the text and replace the open `z.unknown()` with a bounded,
// depth-limited JSON value plus a total-byte ceiling.
const MAX_ANSWER_TEXT = 10_000;
const JSON_MAX_DEPTH = 6;
const JSON_MAX_BYTES = 20_000;
const JSON_MAX_ARRAY = 500;

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// Depth-bounded recursive JSON value: strings capped, arrays length-capped,
// object keys capped. `JSON_MAX_DEPTH` levels of nesting are accepted; deeper
// input fails to match and is rejected.
function jsonValueAtDepth(depth: number): z.ZodType<JsonValue> {
  const scalar = z.union([z.string().max(MAX_ANSWER_TEXT), z.number(), z.boolean(), z.null()]);
  if (depth <= 0) return scalar as z.ZodType<JsonValue>;
  const inner = jsonValueAtDepth(depth - 1);
  return z.union([
    scalar,
    z.array(inner).max(JSON_MAX_ARRAY),
    z.record(z.string().max(200), inner),
  ]) as z.ZodType<JsonValue>;
}

const boundedAnswerJson = jsonValueAtDepth(JSON_MAX_DEPTH)
  .refine((v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8') <= JSON_MAX_BYTES, {
    message: 'answer_json too large',
  })
  .optional();

const Body = z.object({
  answers: z.array(
    z.object({
      question_id: z.string().uuid(),
      answer_text: z.string().max(MAX_ANSWER_TEXT).nullable().optional(),
      answer_json: boundedAnswerJson,
    }),
  ),
});

interface Ctx {
  params: Promise<{ token: string }>;
}

export async function PUT(req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!isValidTokenShape(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const invite = await getInviteByToken(token);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    await saveDraft(invite.id, parsed.data.answers, { ip, userAgent });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
