// ADR-0057 Phase 1 (D3) — the OFFSET-pagination codec for the Salesforce
// Experience Cloud `getItems` list transport. PURE (no Playwright / no DB), so
// the confirmed live mechanism is unit-tested against synthetic fixtures and the
// fragile Playwright I/O (backfill-portal-client.ts) stays a thin shell over it.
//
// CONFIRMED LIVE 2026-07-22 against `mrc-us.my.site.com` (ADR-0057 discovery,
// captured from the real portal): the list uses
// `ListViewDataManagerController.getItems` with OFFSET pagination —
//   request params : { filterName:<listViewId>, entityName:<Object__c>,
//                      pageSize:50, layoutType:"LIST", sortBy:null,
//                      getCount:false, enableRowActions:false, offset:<N> }
//   response scalars: { records/recordIdActionsList:[…≤pageSize], offset:<next>,
//                      hasMoreData:<bool>, filterTitle:"…", entityLabelPlural:"…" }
// PAGING LOOP: start offset=0; each response reports a CUMULATIVE `offset` (the
// count fetched so far) + `hasMoreData`. Because a Salesforce ListView returns
// exactly `pageSize` rows per page until the final page (observed: page-0
// offset:0 → resp offset:50, hasMoreData:true), the next request's offset for a
// 0-based page index is simply `pageIndex * pageSize` — a PURE function of the
// page index. That property is what makes the backfill engine's DB-durable,
// resumable `last_page_index` cursor sound: page N is re-derivable from the
// cursor alone, with no in-memory running offset to lose across a restart.

import { PortalContractDriftError } from './portal-client';
import { listRecordIds } from './mappers';
import type { GetItemsReturnValue } from './types';

/** The Aura action descriptor for the ListView `getItems` transport (confirmed live). */
export const GETITEMS_DESCRIPTOR =
  'serviceComponent://ui.force.components.controllers.lists.listViewDataManager.ListViewDataManagerController/ACTION$getItems';

/** Observed portal page size (confirmed live). One page = up to this many records. */
export const DEFAULT_PAGE_SIZE = 50;

// ── Offset math ──────────────────────────────────────────────────────────────

/**
 * The request `offset` for a 0-based page index. This is the CONFIRMED loop
 * (`next offset = response.offset`) expressed as a pure function of the page
 * index — valid because every ListView page returns exactly `pageSize` rows
 * until the last (Salesforce semantics, observed). Keeping it pure is deliberate:
 * the resumable backfill cursor stores `last_page_index`, so page N must be
 * computable without a running in-memory offset.
 */
export function offsetForPage(pageIndex: number, pageSize: number = DEFAULT_PAGE_SIZE): number {
  return Math.max(0, Math.trunc(pageIndex)) * Math.max(1, Math.trunc(pageSize));
}

// ── getItems request (message) codec ─────────────────────────────────────────

export interface GetItemsParams {
  entityName: string;
  /** The LIST VIEW id (Salesforce `00B…`) — the `filterName` param. */
  filterName: string;
  offset: number;
  pageSize?: number;
  /**
   * The list-view sort override. `'Id'` / `'-Id'` = ascending / descending by the
   * unique Record ID — a stable TOTAL order (CONFIRMED live 2026-07-22:
   * orderedByInfo echoes "Record ID" asc/desc). `null`/absent keeps the view's
   * own default sort. The sort-flip pagination (see {@link sortFlipStep}) drives
   * `'Id'` then `'-Id'` to reach past the SOQL OFFSET 2000 ceiling.
   */
  sortBy?: string | null;
  /**
   * Ask the list view to also compute its absolute `totalCount` (CONFIRMED live:
   * `getCount:true` ⇒ the returnValue carries `totalCount`). The sort-flip planner
   * needs it to know how many pages/directions cover the view and to fail LOUD
   * when a view exceeds the reachable window.
   */
  getCount?: boolean;
}

/**
 * Build the JSON string for the Aura `message` form field: exactly one getItems
 * action carrying the CONFIRMED param set. `actionId` is the client-side action
 * id (cosmetic; the server echoes it). The params object key order matches the
 * captured request for byte-parity paranoia, but the server is order-agnostic.
 */
export function buildGetItemsMessage(p: GetItemsParams, actionId: string = '0'): string {
  const message = {
    actions: [
      {
        id: actionId,
        descriptor: GETITEMS_DESCRIPTOR,
        callingDescriptor: 'UNKNOWN',
        params: {
          filterName: p.filterName,
          entityName: p.entityName,
          pageSize: p.pageSize ?? DEFAULT_PAGE_SIZE,
          layoutType: 'LIST',
          sortBy: p.sortBy ?? null,
          getCount: p.getCount ?? false,
          enableRowActions: false,
          offset: p.offset,
        },
      },
    ],
  };
  return JSON.stringify(message);
}

// ── Sort-flip pagination plan (breaks the SOQL OFFSET 2000 ceiling) ───────────
//
// CONFIRMED LIVE 2026-07-22 against `mrc-us.my.site.com` (probe capture):
//   • `getItems` is HARD-capped at pageSize 2000 (5000/6200/10000 all return 2000).
//   • the `offset` param is HARD-capped at 2000 (offset 2050+ returns a degenerate
//     SUCCESS with NO recordIdActionsList and a "list view isn't available in
//     Lightning" `message` — the silent truncation this fix kills). This is the
//     SOQL `OFFSET` clause limit (max 2000).
//   • there is NO page/cursor token anywhere in the returnValue, and the org has
//     the UI-API disabled (`API_DISABLED_FOR_ORG`) — so a cursor transport is out.
//   • `sortBy:'Id'`/`'-Id'` IS honoured (orderedByInfo → "Record ID" asc/desc).
//   • `getCount:true` returns the absolute `totalCount`.
//
// STRATEGY — sort-flip. With pageSize 2000 and the offset capped at 2000, ONE sort
// direction reaches the FIRST `2*PAGE_SIZE` (=4000) rows by Id: offset 0 → ranks
// [0,2000), offset 2000 → ranks [2000,4000). Ascending by the unique Id covers the
// low 4000; descending covers the high 4000 (the last 4000 rows). Their union is
// the WHOLE view iff `totalCount ≤ 4*PAGE_SIZE` (=8000) — the two windows meet in
// the middle. Overlap deduplicates naturally on the mirror upsert key
// (`salesforce_record_id`). A view with `totalCount > 8000` has a middle rank
// window neither direction can reach: the planner refuses to mark it complete and
// wedges LOUD (never a silent cap).

/** getItems pageSize cap == the SOQL OFFSET cap (both 2000, CONFIRMED live). The
 *  sort-flip plan's second offset step equals this, so no request exceeds either. */
export const BACKFILL_PAGE_SIZE = 2_000;

/** Ascending / descending sort on the unique Record ID — a stable total order. */
const SORT_ASC = 'Id';
const SORT_DESC = '-Id';

/**
 * The sort-flip step for a 0-based `pageIndex`, or `null` when the index is past
 * the plan (only reached on the coverage-overflow wedge, or a stale pre-sort-flip
 * cursor). Four steps: asc@0, asc@PAGE_SIZE, desc@0, desc@PAGE_SIZE — the two
 * ascending steps tile the first 4000 rows, the two descending steps the last
 * 4000. `pageSize` is injectable purely so tests can shrink the ceiling.
 */
export function sortFlipStep(
  pageIndex: number,
  pageSize: number = BACKFILL_PAGE_SIZE,
): { sortBy: string; offset: number } | null {
  const steps: ReadonlyArray<{ sortBy: string; offset: number }> = [
    { sortBy: SORT_ASC, offset: 0 },
    { sortBy: SORT_ASC, offset: pageSize },
    { sortBy: SORT_DESC, offset: 0 },
    { sortBy: SORT_DESC, offset: pageSize },
  ];
  return steps[pageIndex] ?? null;
}

/** Number of sort-flip steps in the plan (the coverage ceiling is `2*this*pageSize/2`… i.e. `2*pageSize*2`). */
export const SORT_FLIP_STEP_COUNT = 4;

/**
 * The 0-based index of the LAST sort-flip step needed to fully cover a view of
 * `totalCount` rows: `ceil(totalCount / pageSize) - 1`, because each step yields
 * one `pageSize` window and asc+desc tile from both ends. The engine stops (sets
 * `completed_at`) when the page it just fetched is this index.
 */
export function sortFlipLastPageIndex(
  totalCount: number,
  pageSize: number = BACKFILL_PAGE_SIZE,
): number {
  const ps = Math.max(1, Math.trunc(pageSize));
  return Math.ceil(Math.max(0, totalCount) / ps) - 1;
}

/**
 * `true` when a view of `totalCount` rows exceeds what sort-flip can reach
 * (`> 4 * pageSize` = 8000 live): the two 4000-row windows no longer meet, so a
 * middle rank band is unreachable via the getItems offset ceiling. The client
 * turns this into a LOUD wedge — it must never masquerade as complete.
 */
export function sortFlipExceedsCoverage(
  totalCount: number,
  pageSize: number = BACKFILL_PAGE_SIZE,
): boolean {
  const ps = Math.max(1, Math.trunc(pageSize));
  return totalCount > SORT_FLIP_STEP_COUNT * ps;
}

// ── getItems response codec ──────────────────────────────────────────────────

/** The scalars we read from a `getItems` returnValue (all CONFIRMED live). */
export interface GetItemsPage {
  recordIds: string[];
  /** The response's CUMULATIVE offset (count fetched so far), or null if absent. */
  offset: number | null;
  hasMoreData: boolean;
  filterTitle: string | null;
  entityLabelPlural: string | null;
  /** The list view's absolute record count when `getCount:true` was sent (else null). */
  totalCount: number | null;
}

interface GetItemsReturnScalars extends GetItemsReturnValue {
  offset?: unknown;
  filterTitle?: unknown;
  entityLabelPlural?: unknown;
  totalCount?: unknown;
  message?: unknown;
}

function isGetItemsReturnValue(v: unknown): v is GetItemsReturnScalars {
  return !!v && typeof v === 'object' && 'recordIdActionsList' in v;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Parse a raw Aura response body (the `/s/sfsites/aura` envelope) into the
 * getItems page. Throws {@link PortalContractDriftError} when there is no SUCCESS
 * getItems action or the list view reported an error — a green run with no data
 * is impossible by construction (ADR-0038 D4), exactly like the interception
 * transport's `extractListView`.
 */
export function parseGetItemsResponse(body: string): GetItemsPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PortalContractDriftError('getItems: response body was not JSON');
  }
  const actions =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)
      ? (parsed as { actions: Array<{ state?: string; returnValue?: unknown }> }).actions
      : [];
  for (const action of actions) {
    if (action?.state !== 'SUCCESS') continue;
    if (isGetItemsReturnValue(action.returnValue)) {
      const rv = action.returnValue;
      if (rv.isErrorListView === true) {
        throw new PortalContractDriftError('getItems: list view reported isErrorListView=true');
      }
      return {
        recordIds: listRecordIds(rv),
        offset: numOrNull(rv.offset),
        hasMoreData: rv.hasMoreData === true,
        filterTitle: strOrNull(rv.filterTitle),
        entityLabelPlural: strOrNull(rv.entityLabelPlural),
        totalCount: numOrNull((rv as GetItemsReturnScalars).totalCount),
      };
    }
    // The OFFSET-CEILING response: a SUCCESS action whose returnValue has NO
    // recordIdActionsList but carries `message` + `hasMoreData:false` — what the
    // portal returns past offset 2000 ("this list view isn't available in
    // Lightning…"). The sort-flip plan never requests offset > pageSize so this is
    // not expected, but if the portal shifts we surface a CLEAR ceiling error
    // rather than the old misleading "no getItems action" (which masked the 2050
    // truncation as generic drift).
    const rv = action.returnValue as GetItemsReturnScalars | undefined;
    if (
      rv &&
      typeof rv === 'object' &&
      'message' in rv &&
      'hasMoreData' in rv &&
      !('recordIdActionsList' in rv)
    ) {
      throw new PortalContractDriftError(
        `getItems: offset-ceiling response (no records; message: ${JSON.stringify(strOrNull(rv.message))}) — ` +
          `requested offset exceeded the SOQL OFFSET 2000 cap`,
      );
    }
  }
  throw new PortalContractDriftError(
    `getItems: no SUCCESS ListViewDataManager getItems action in the Aura response (${actions.length} action(s))`,
  );
}

// ── Aura framework-param codec (session envelope reuse) ──────────────────────
//
// The offset replay reuses the SAME aura framework envelope the browser already
// sent (aura.context/token/pageURI) — this is what immunizes ladder #1 against
// the per-release `fwuid` drift (the browser reconstructs a valid envelope on
// every list-page load; we lift it verbatim and only swap the getItems `offset`).

export interface AuraFrameworkParams {
  /** Serialized aura context (carries the live `fwuid` + app descriptor). */
  auraContext: string;
  /** CSRF token for the session. */
  auraToken: string;
  /** The page URI the browser attributed the request to (cosmetic but sent). */
  auraPageUri: string;
}

/**
 * Parse a captured OUTGOING Aura POST body (application/x-www-form-urlencoded)
 * into its framework params + the `message`. Returns `null` for `message` /
 * fields not present so a non-getItems Aura request is skippable by the caller.
 */
export function parseAuraPostData(postData: string): {
  message: string | null;
  framework: AuraFrameworkParams | null;
} {
  const p = new URLSearchParams(postData);
  const auraContext = p.get('aura.context');
  const auraToken = p.get('aura.token');
  const auraPageUri = p.get('aura.pageURI');
  const framework =
    auraContext !== null
      ? { auraContext, auraToken: auraToken ?? '', auraPageUri: auraPageUri ?? '' }
      : null;
  return { message: p.get('message'), framework };
}

/**
 * `true` when a captured `message` is a getItems action — so the framework-param
 * capture picks the RIGHT request (a list page also fires unrelated Aura calls).
 */
export function messageIsGetItems(message: string): boolean {
  return message.includes('ListViewDataManagerController') && message.includes('getItems');
}

/**
 * The form fields for an offset-replay POST: the captured framework envelope with
 * a freshly-built getItems `message` swapping in the target offset/filter/entity.
 */
export function buildGetItemsFormFields(
  framework: AuraFrameworkParams,
  params: GetItemsParams,
  actionId: string = '0',
): Record<string, string> {
  return {
    message: buildGetItemsMessage(params, actionId),
    'aura.context': framework.auraContext,
    'aura.pageURI': framework.auraPageUri,
    'aura.token': framework.auraToken,
  };
}

// ── List-view id resolution (runtime > config > observed, never guess) ────────

/**
 * One (object, list-view) the backfill must page. `slug` is the DR3-internal
 * `list_view_api_name` cursor key (`''` for a single-view object); `objectApiName`
 * is BOTH the cursor object and the getItems `entityName`; `filterTitle` is the
 * portal's human list-view title used to match a runtime capture; `observedFilterName`
 * is the `00B…` list-view id captured LIVE 2026-07-22, or `null` when it was not
 * captured (must be resolved at runtime or supplied via config).
 */
export interface ListViewBinding {
  slug: string;
  objectApiName: string;
  filterTitle: string;
  observedFilterName: string | null;
}

/**
 * The 8 (object, list-view) cursors of the 4 real objects — the ACTIVE/default
 * views AND the HISTORY views (added ADR-0057 D3, 2026-07-22). The active views
 * alone miss the bulk of the record history: the live first backfill paged only
 * the default views, so "Completed Hauls" (~720+ historical trailer deliveries)
 * and the two inactive-Materials views were never pulled. Paging BOTH the active
 * and the history view per object is what makes the backfill full-history.
 *
 * Dedup is the mirror upsert key (`salesforce_record_id`): a haul id that appears
 * in both an active view (docking/consumer) AND "Completed Hauls" upserts ONCE —
 * the two cursors page independently, the mirror stores the id once, and the
 * detail sweep (`detail_fetched_at IS NULL`, targets run sequentially) fetches it
 * once. Inactive Materials still route by `Type__c` to processed/outbound — the
 * inactive VIEWS only widen coverage; the routing is unchanged.
 *
 * `observedFilterName` carries the `00B…`/`00BUJ…` id captured LIVE 2026-07-22
 * (6 views — Outbound active added on the sort-flip probe re-capture); the other 2
 * (Consumer Drop-Off, Dock) are `null` on
 * purpose — ADR-0057 forbids GUESSING a transport id, so they resolve at RUNTIME
 * (from the browser's own getItems request on the list page) or from an operator
 * override (`MYMRC_LISTVIEW_IDS`), and a target whose id resolves to NONE fails
 * LOUD per-target (a wedge the engine records + pages) rather than paging a
 * wrong/empty list silently. Adding a further view later is a one-line change.
 */
export const BACKFILL_LIST_VIEWS: readonly ListViewBinding[] = [
  // ── Haul_Request__c → mymrc_hauls_mirror ──
  {
    slug: 'docking_appointments_rc',
    objectApiName: 'Haul_Request__c',
    filterTitle: 'Docking Appointments (RC)',
    observedFilterName: '00B4p000005DAqWEAW',
  },
  {
    slug: 'consumer_drop_off_rc',
    objectApiName: 'Haul_Request__c',
    filterTitle: 'Consumer Drop-Off (RC)',
    observedFilterName: null,
  },
  {
    // HISTORY view — the bulk of haul history (~720+ completed hauls, paginates).
    slug: 'completed_hauls',
    objectApiName: 'Haul_Request__c',
    filterTitle: 'Completed Hauls',
    observedFilterName: '00B4p000005DAqSEAW',
  },
  // ── Materials__c → mymrc_processed_mirror / mymrc_outbound_mirror (split by Type__c) ──
  {
    slug: 'processed_active',
    objectApiName: 'Materials__c',
    filterTitle: 'All Active Processed Materials',
    observedFilterName: '00B4p000005DAqlEAG',
  },
  {
    // HISTORY view — inactive processed materials (still Type__c 'Processing').
    slug: 'processed_inactive',
    objectApiName: 'Materials__c',
    filterTitle: 'All Inactive Processed Materials',
    observedFilterName: '00BUJ000001sJxx2AE',
  },
  {
    slug: 'outbound_active',
    objectApiName: 'Materials__c',
    filterTitle: 'All Active Outbound Materials',
    // Captured LIVE 2026-07-22 (sort-flip probe) — runtime capture on
    // /s/outbound-materials returned this id for the title. Pinned so the view
    // resolves even if a future capture misses it.
    observedFilterName: '00B4p000005DAqkEAG',
  },
  {
    // HISTORY view — inactive outbound materials (still Type__c 'Outbound').
    slug: 'outbound_inactive',
    objectApiName: 'Materials__c',
    filterTitle: 'All Inactive Outbound Materials',
    observedFilterName: '00BUJ000001sJuj2AE',
  },
  // ── Dock_Availability_Schedule__c → mymrc_dock_availability_mirror (single view) ──
  {
    slug: '',
    objectApiName: 'Dock_Availability_Schedule__c',
    filterTitle: 'Active Availability Schedules (RC)',
    observedFilterName: null,
  },
] as const;

/**
 * A list view the browser actually requested on a list page: its getItems
 * request `params` gave us `{ entityName, filterName }`, and the paired RESPONSE
 * gave us `filterTitle`. Correlating request→response by Aura action id yields
 * the AUTHORITATIVE runtime id for that title (immune to the observed id drifting).
 */
export interface CapturedListView {
  entityName: string;
  filterName: string;
  filterTitle: string | null;
}

/** The getItems request params we correlate against a response (from `message`). */
export interface CapturedGetItemsRequest {
  actionId: string | null;
  entityName: string | null;
  filterName: string | null;
}

/**
 * Pull the getItems request descriptor out of a captured `message`. Returns the
 * action id + entityName + filterName (any may be null on an unexpected shape).
 */
export function parseGetItemsRequest(message: string): CapturedGetItemsRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  const actions =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)
      ? (parsed as { actions: Array<Record<string, unknown>> }).actions
      : [];
  for (const a of actions) {
    const descriptor = typeof a['descriptor'] === 'string' ? (a['descriptor'] as string) : '';
    const params = (a['params'] ?? {}) as Record<string, unknown>;
    const isGetItems =
      descriptor.includes('ListViewDataManagerController') && descriptor.includes('getItems');
    if (!isGetItems && !('filterName' in params)) continue;
    return {
      actionId: typeof a['id'] === 'string' ? (a['id'] as string) : null,
      entityName:
        typeof params['entityName'] === 'string' ? (params['entityName'] as string) : null,
      filterName:
        typeof params['filterName'] === 'string' ? (params['filterName'] as string) : null,
    };
  }
  return null;
}

/** One getItems action found in a response envelope: its echoed id + title. */
interface ResponseGetItemsAction {
  actionId: string | null;
  filterTitle: string | null;
}

/** Every SUCCESS getItems action across a response body, with its echoed id. */
function extractResponseGetItemsActions(body: string): ResponseGetItemsAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const actions =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)
      ? (parsed as { actions: Array<Record<string, unknown>> }).actions
      : [];
  const out: ResponseGetItemsAction[] = [];
  for (const a of actions) {
    if (a['state'] !== 'SUCCESS' || !isGetItemsReturnValue(a['returnValue'])) continue;
    const rv = a['returnValue'] as GetItemsReturnScalars;
    out.push({
      actionId: typeof a['id'] === 'string' ? (a['id'] as string) : null,
      filterTitle: strOrNull(rv.filterTitle),
    });
  }
  return out;
}

/**
 * Correlate captured OUTGOING getItems requests (which carry `entityName` +
 * `filterName`) with their RESPONSES (which carry the human `filterTitle`) by the
 * echoed Aura action id, yielding the runtime {@link CapturedListView} set that
 * {@link resolveFilterName} matches a binding against. Pure — the Playwright
 * adapter feeds it the intercepted request messages + response bodies.
 */
export function correlateCapturedListViews(
  requestMessages: readonly string[],
  responseBodies: readonly string[],
): CapturedListView[] {
  const titleByActionId = new Map<string, string | null>();
  for (const body of responseBodies) {
    for (const a of extractResponseGetItemsActions(body)) {
      if (a.actionId !== null) titleByActionId.set(a.actionId, a.filterTitle);
    }
  }
  const out: CapturedListView[] = [];
  const seen = new Set<string>();
  for (const message of requestMessages) {
    const req = parseGetItemsRequest(message);
    if (!req || req.entityName === null || req.filterName === null) continue;
    const filterTitle = req.actionId !== null ? (titleByActionId.get(req.actionId) ?? null) : null;
    // NUL separates the two halves so no entity/filter pair can collide with
    // another by concatenation. Write it as the ESCAPE, never a literal NUL byte:
    // a raw 0x00 makes this whole file read as BINARY to grep/ripgrep, which then
    // skip it silently — every codebase-wide audit gets a 571-line blind spot and
    // reports zero hits rather than an error (ADR-0103).
    const dedupKey = `${req.entityName}\u0000${req.filterName}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ entityName: req.entityName, filterName: req.filterName, filterTitle });
  }
  return out;
}

/**
 * Resolve the getItems `filterName` (list-view id) for a binding, in strict
 * precedence:
 *   1. `configOverride` — an operator-supplied `{ slug → id }` map (env), highest
 *      authority (lets Bill unblock a not-yet-captured view without a code change).
 *   2. a RUNTIME `CapturedListView` matched by (entityName === objectApiName &&
 *      filterTitle === binding.filterTitle) — the browser's own id, drift-proof.
 *   3. the binding's `observedFilterName` (captured live 2026-07-22).
 * Returns `null` when NONE yields an id — the caller MUST fail loud, never guess.
 */
export function resolveFilterName(
  binding: ListViewBinding,
  captured: readonly CapturedListView[],
  configOverride: Readonly<Record<string, string>> = {},
): string | null {
  const override = configOverride[binding.slug];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();

  for (const c of captured) {
    if (
      c.entityName === binding.objectApiName &&
      c.filterTitle !== null &&
      c.filterTitle === binding.filterTitle &&
      c.filterName.trim() !== ''
    ) {
      return c.filterName;
    }
  }

  if (binding.observedFilterName && binding.observedFilterName.trim() !== '') {
    return binding.observedFilterName;
  }
  return null;
}
