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
          sortBy: null,
          getCount: false,
          enableRowActions: false,
          offset: p.offset,
        },
      },
    ],
  };
  return JSON.stringify(message);
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
}

interface GetItemsReturnScalars extends GetItemsReturnValue {
  offset?: unknown;
  filterTitle?: unknown;
  entityLabelPlural?: unknown;
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
      ? ((parsed as { actions: Array<{ state?: string; returnValue?: unknown }> }).actions)
      : [];
  for (const action of actions) {
    if (action?.state === 'SUCCESS' && isGetItemsReturnValue(action.returnValue)) {
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
      };
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
 * The 5 (object, list-view) cursors of the 4 real objects. Only 2 list-view ids
 * were captured live 2026-07-22 (`observedFilterName`); the other 3 are `null` on
 * purpose — ADR-0057 forbids GUESSING a transport id, so they resolve at RUNTIME
 * (from the browser's own getItems request on the list page) or from an operator
 * override, and a target whose id resolves to NONE fails LOUD per-target (a wedge
 * the engine records + pages) rather than paging a wrong/empty list silently.
 */
export const BACKFILL_LIST_VIEWS: readonly ListViewBinding[] = [
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
    slug: 'processed_active',
    objectApiName: 'Materials__c',
    filterTitle: 'All Active Processed Materials',
    observedFilterName: '00B4p000005DAqlEAG',
  },
  {
    slug: 'outbound_active',
    objectApiName: 'Materials__c',
    filterTitle: 'All Active Outbound Materials',
    observedFilterName: null,
  },
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
      entityName: typeof params['entityName'] === 'string' ? (params['entityName'] as string) : null,
      filterName: typeof params['filterName'] === 'string' ? (params['filterName'] as string) : null,
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
    const dedupKey = `${req.entityName} ${req.filterName}`;
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
