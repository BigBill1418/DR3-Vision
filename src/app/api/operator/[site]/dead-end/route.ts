// ADR-0100 / ADR-0094 §P0 — the beacon a CLIENT-rendered dead end reports through.
//
// Server components (the queue's withdrawn block, the site picker) call
// `recordDeadEnd` directly. Client components cannot: pino is Node-only and is
// listed in `serverExternalPackages` precisely so it never reaches the bundle. So
// the browser gets one narrow endpoint.
//
// ## What this route accepts, and what it refuses to be told
//
// The payload carries a SURFACE, a STATE and — optionally — the id of the object
// the operator is looking at. That is the whole schema. It does NOT accept a user
// id, a role, a site or a locale: all four are resolved server-side, because a
// telemetry endpoint that believes the client about who it is produces a metric
// anybody with a session can forge, and a forged metric is worse than none
// (ADR-0019.5: counters that reported attempts as successes are why nobody
// noticed a week of dropped pages).
//
// `surface` and `state` are validated against the CLOSED unions in `dead-end.ts`
// rather than taken as strings. They become Prometheus label values, so an
// unvalidated string here is an unbounded-cardinality hole reachable by anyone
// with an operator session — this check is the fence, not a formality.
//
// ## Why 204 and never a body
//
// Nothing the client can do with a response. Answering `204 No Content` keeps the
// beacon fire-and-forget and means a failure here cannot change what the operator
// sees, which is the point: the instrument must never be able to break the screen
// it is measuring.

import { requireOperatorForSite } from '@/lib/auth-helpers';
import { auth } from '@/lib/auth';
import { getLocale } from '@/i18n/get-locale';
import {
  recordDeadEnd,
  recordWriteRefusal,
  type DeadEndSurface,
  type DeadEndState,
  type WriteRefusalKind,
} from '@/lib/observability/dead-end';
import {
  STAGE_IDS,
  STAGE_CONTROL_IDS,
  STAGE_DISABLE_REASONS,
  type StageId,
} from '@/lib/floor/stage-controls';
import { publishStageDeadEndAlert } from '@/lib/floor/dead-end-alert';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The closed sets, restated as runtime values. `satisfies` keeps them in lock-step. */
const SURFACES = [
  'hauls',
  'queue',
  'load',
  'conflicts',
  'count',
  'inbound',
  'processed',
  'dropoff',
  'site_picker',
  'load_stage',
] as const satisfies readonly DeadEndSurface[];

const STATES = [
  'slot_withdrawn',
  'view_only',
  'load_closed',
  'already_worked',
  'no_portal_feed',
  'no_inbound_days',
  'queue_unreadable',
  'hold_gone',
  'no_sites',
  'no_live_controls',
] as const satisfies readonly DeadEndState[];

const REFUSALS = ['wrong_day', 'signed_out'] as const satisfies readonly WriteRefusalKind[];

/** Long enough for a uuid; short enough that nobody can post prose into a label. */
const OBJECT_ID_MAX = 64;

function isOneOf<T extends string>(vals: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (vals as readonly string[]).includes(v);
}

/**
 * ADR-0122 — the disable-reason snapshot, validated key AND value.
 *
 * Both sides come from the closed arrays in `@/lib/floor/stage-controls`, so a
 * client cannot post prose into the log line. `MAX_REASONS` is a belt-and-braces
 * cap: the control inventory has 19 entries today, and a payload larger than the
 * entire vocabulary is a client that is not ours.
 *
 * Returns `{}` rather than refusing on a malformed entry. The event itself — a
 * stage with no live control — is the thing worth having; dropping it because
 * one key was unrecognised would trade the signal for the diagnostic.
 */
const MAX_REASONS = 32;

function parseReasons(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_REASONS) break;
    if (!isOneOf(STAGE_CONTROL_IDS, k)) continue;
    if (!isOneOf(STAGE_DISABLE_REASONS, v)) continue;
    out[k] = v;
    n++;
  }
  return out;
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    // Same guard as every other floor write: an operator, PIN-activated, hard
    // scoped to this site. Deliberately NOT rollout-gated — the instrument has to
    // work on surfaces that are still `pilot`, which are exactly the ones whose
    // dead ends nobody has found yet.
    const ctx = await requireOperatorForSite(site);
    const session = await auth();

    const body: unknown = await req.json().catch(() => null);
    if (body === null || typeof body !== 'object') return new Response(null, { status: 204 });
    const b = body as Record<string, unknown>;

    if (!isOneOf(SURFACES, b['surface'])) return new Response(null, { status: 204 });

    const rawId = b['objectId'];
    const objectId =
      typeof rawId === 'string' && rawId.length > 0 && rawId.length <= OBJECT_ID_MAX ? rawId : null;

    // Resolved SERVER-SIDE, like identity and site. `getLocale()` is
    // session-first (ADR-0061 D-4), so this is the operator's stored preference
    // rather than whatever the client last painted — and one fewer field the
    // payload can lie about.
    const locale = await getLocale();
    const role = session?.user?.role ?? 'operator';

    if (isOneOf(REFUSALS, b['refusal'])) {
      recordWriteRefusal({
        surface: b['surface'],
        refusal: b['refusal'],
        siteCode: ctx.siteCode,
        userId: ctx.userId,
        role,
        locale,
      });
      return new Response(null, { status: 204 });
    }

    if (!isOneOf(STATES, b['state'])) return new Response(null, { status: 204 });

    // ADR-0122 — `stage` and the disable-reason snapshot ride only on the
    // `load_stage` surface. Validated against the same closed arrays the browser
    // derives its types from, so neither can drift from the other.
    const stage: StageId | undefined = isOneOf(STAGE_IDS, b['stage']) ? b['stage'] : undefined;
    const disableReasons = parseReasons(b['reasons']);

    recordDeadEnd({
      surface: b['surface'],
      state: b['state'],
      objectId,
      siteCode: ctx.siteCode,
      userId: ctx.userId,
      role,
      locale,
      stage,
      ...(Object.keys(disableReasons).length > 0 ? { disableReasons } : {}),
    });

    // ADR-0122 / ADR-0121 §Follow-ups — the ONE dead-end state that pages.
    //
    // `objectId` and `stage` are required for it, not optional: the alert's whole
    // value is the tier-1 click to the trapped load, and a page whose click lands
    // on a status dashboard is the tier-3 shape ADR-0036 asks us to avoid. A
    // report missing either is still counted and logged above — the metric does
    // not depend on the page.
    //
    // AWAITED rather than fired-and-forgotten. `publishNtfy` carries its own
    // 12-second total budget and never throws, and the 15-minute per-(load,
    // stage) cooldown means at most one publish per trapped load. A floating
    // promise here would be a page that races the response — the ADR-0117 shape
    // (a promise in one process's memory is not a delivery). The client never
    // reads this response, so the added latency costs the operator nothing.
    if (b['state'] === 'no_live_controls' && objectId !== null && stage !== undefined) {
      await publishStageDeadEndAlert({
        siteCode: ctx.siteCode,
        loadId: objectId,
        stage,
        disableReasons,
      });
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    // The auth guards throw a bare `Response`. Pass its STATUS through — a 401
    // here is real information (the beacon fired behind a dead session, which is
    // itself a floor condition worth seeing) — but never a body.
    if (e instanceof Response) return new Response(null, { status: e.status });
    return new Response(null, { status: 204 });
  }
}
