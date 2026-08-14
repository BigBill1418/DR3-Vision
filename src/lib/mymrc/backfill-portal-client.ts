// ADR-0057 Phase 1 (D3) — the SORT-FLIP-paginating BackfillPortalClient.
//
// This is the production adapter the windowed backfill engine (backfill.ts) was
// built to consume: `fetchListPage(objectApiName, listViewApiName, pageIndex)`.
// It maps the engine's 0-based `pageIndex` onto the sort-flip PLAN (`sortFlipStep`
// — asc@0, asc@pageSize, desc@0, desc@pageSize; see list-page.ts) and replays the
// Aura getItems action against `/s/sfsites/aura`, reusing the live aura framework
// envelope the browser itself sent on the list page (immune to fwuid drift) — the
// replay path (ladder #1), chosen for DETERMINISM: page N is a pure function of
// the cursor, so the engine's DB-durable `last_page_index` resume is exact and a
// page is never skipped or double-fetched.
//
// WHY SORT-FLIP (not plain offset): the Salesforce list-view getItems transport is
// hard-capped at OFFSET 2000 (SOQL limit) — plain `offset = pageIndex*pageSize`
// TRUNCATED "Completed Hauls" / "All Active Outbound Materials" at 2050 rows (the
// live bug this fixes). CONFIRMED LIVE 2026-07-22: no cursor token, UI-API
// disabled, but pageSize 2000 + `sortBy:'Id'`/`'-Id'` + `getCount:true` are all
// honoured — so ascending Id reaches the first 4000 rows, descending the last
// 4000, and their union is the whole view when `totalCount ≤ 8000` (overlap dedups
// on the mirror upsert key). A view above 8000 wedges LOUD, never silently caps.
//
// LAYERING (why an injectable `BackfillSession`): the fragile Playwright I/O is
// isolated behind `BackfillSession`, so the offset loop, list-view id resolution,
// and the auth-failure mapping are all unit-tested against a fake — while the raw
// browser calls (`playwrightBackfillSession`) stay a thin, hand-verified shell
// (validated by rebuilding the image + running against CHAD, per ADR-0057).
//
// Bundle constraint: compiles standalone via tsconfig.mymrc.json — no `@/…`.

import type { Request as PwRequest, Response as PwResponse } from 'playwright';
import type { BackfillListPage, BackfillPortalClient } from './backfill';
import { AuthFailedError, PortalContractDriftError, type AdminSession } from './portal-client';
import {
  BACKFILL_LIST_VIEWS,
  BACKFILL_PAGE_SIZE,
  buildGetItemsFormFields,
  correlateCapturedListViews,
  messageIsGetItems,
  parseAuraPostData,
  parseGetItemsResponse,
  resolveFilterName,
  sortFlipExceedsCoverage,
  sortFlipLastPageIndex,
  sortFlipStep,
  SORT_FLIP_STEP_COUNT,
  type AuraFrameworkParams,
  type CapturedListView,
  type ListViewBinding,
} from './list-page';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

// ── list-page routing (DR3-internal, mirrors OBJECT_NAV_SLUGS) ────────────────
//
// Which authenticated list page to load to (a) capture the aura envelope and (b)
// resolve a list-view id at runtime. Keyed by the DR3 `list_view_api_name` slug
// because the two Materials nav pages are SEPARATE, while all Haul views share
// `/s/hauls`. A HISTORY view (completed_hauls / *_inactive, ADR-0057 D3) lives on
// the SAME object nav page as its active sibling — the list-view PICKER switches
// which view renders, so the route is shared and the id is resolved by observed
// fallback / override / runtime capture, not by a distinct page. These bindings
// are stable DR3 conventions; a redesign that moves them fails LOUD (no capture →
// PortalContractDriftError), never silent.
const LIST_PAGE_BY_SLUG: Readonly<Record<string, string>> = {
  docking_appointments_rc: '/s/hauls',
  consumer_drop_off_rc: '/s/hauls',
  completed_hauls: '/s/hauls',
  processed_active: '/s/processed-materials',
  processed_inactive: '/s/processed-materials',
  outbound_active: '/s/outbound-materials',
  outbound_inactive: '/s/outbound-materials',
  '': '/s/availability',
};

// ── Injectable session (the Playwright seam) ─────────────────────────────────

/**
 * What one page of offset-paginated backfill needs from the browser. Everything
 * fragile lives behind this interface so the transport logic is fake-testable.
 */
export interface BackfillSession {
  /**
   * Load the list page at `path` and capture the aura framework envelope + every
   * getItems (request-message, response-body) the page fired. The adapter may
   * cache per path (the framework envelope is session-wide; the view set is
   * per-page). Returns `framework:null` when no getItems Aura request was seen.
   */
  captureListPage(path: string): Promise<{
    framework: AuraFrameworkParams | null;
    requestMessages: string[];
    responseBodies: string[];
  }>;
  /** POST an offset-replay to the Aura endpoint with the given form fields → raw response body. */
  postGetItems(formFields: Record<string, string>): Promise<string>;
  /** `true` when the session currently looks logged-out. */
  isLoggedOut(): Promise<boolean>;
  /** Purge the poisoned storageState so the next run boots clean. */
  purgeState(): Promise<void>;
}

export interface BackfillPortalClientOptions {
  /** Operator override `{ slug → list-view id }` (highest-authority id source). */
  listViewOverrides?: Readonly<Record<string, string>>;
  pageSize?: number;
  log?: Logger;
}

function findBinding(objectApiName: string, slug: string): ListViewBinding | null {
  return (
    BACKFILL_LIST_VIEWS.find((b) => b.objectApiName === objectApiName && b.slug === slug) ?? null
  );
}

/**
 * Build a {@link BackfillPortalClient} over an injectable {@link BackfillSession}.
 * Lazily captures each list page once (framework envelope + runtime list-view
 * ids), resolves the getItems `filterName` per target (runtime > override >
 * observed, never guessed), and pages by offset until `hasMoreData:false`.
 */
export function createBackfillPortalClient(
  session: BackfillSession,
  opts: BackfillPortalClientOptions = {},
): BackfillPortalClient {
  const log = opts.log ?? noopLog;
  const pageSize = opts.pageSize ?? BACKFILL_PAGE_SIZE;
  const overrides = opts.listViewOverrides ?? {};

  // Session-wide caches: the aura framework envelope (any list page yields it) and
  // the union of runtime-captured list views (each page contributes its own).
  let framework: AuraFrameworkParams | null = null;
  const capturedViews: CapturedListView[] = [];
  const capturedPaths = new Set<string>();
  let actionSeq = 0;

  async function ensureCaptured(path: string): Promise<void> {
    if (capturedPaths.has(path)) return;
    const cap = await session.captureListPage(path);
    capturedPaths.add(path);
    if (cap.framework && !framework) framework = cap.framework;
    for (const v of correlateCapturedListViews(cap.requestMessages, cap.responseBodies)) {
      if (
        !capturedViews.some((c) => c.entityName === v.entityName && c.filterName === v.filterName)
      ) {
        capturedViews.push(v);
      }
    }
    log(
      'info',
      `mymrc-backfill: captured ${path} — framework=${framework ? 'yes' : 'no'}, ${capturedViews.length} runtime list-view id(s) known`,
    );
  }

  return {
    async fetchListPage(objectApiName, listViewApiName, pageIndex): Promise<BackfillListPage> {
      const binding = findBinding(objectApiName, listViewApiName);
      if (!binding) {
        // A cursor with no binding is a wiring bug — loud, never a silent empty.
        throw new PortalContractDriftError(
          `mymrc-backfill: no list-view binding for ${objectApiName}/${listViewApiName || '(default)'}`,
        );
      }
      const path = LIST_PAGE_BY_SLUG[listViewApiName];
      if (path === undefined) {
        throw new PortalContractDriftError(
          `mymrc-backfill: no list-page route for slug "${listViewApiName}"`,
        );
      }
      await ensureCaptured(path);

      if (!framework) {
        // No aura envelope captured — offset replay is impossible; fail loud so the
        // engine records a resumable wedge (never guess an envelope).
        throw new PortalContractDriftError(
          `mymrc-backfill: no Aura framework envelope captured from ${path} — cannot replay getItems`,
        );
      }
      const filterName = resolveFilterName(binding, capturedViews, overrides);
      if (!filterName) {
        throw new PortalContractDriftError(
          `mymrc-backfill: could not resolve list-view id for ${objectApiName}/${listViewApiName || '(default)'} ` +
            `("${binding.filterTitle}") — not captured at runtime, no observed id, no override. ` +
            `Supply it via config or re-capture the list page.`,
        );
      }

      // SORT-FLIP pagination (breaks the SOQL OFFSET 2000 ceiling; see list-page.ts).
      // `pageIndex` indexes the fixed 4-step plan (asc@0, asc@pageSize, desc@0,
      // desc@pageSize). An index past the plan is only reachable on the
      // coverage-overflow path OR a stale pre-sort-flip cursor — either way, fail
      // LOUD rather than silently mark complete.
      const step = sortFlipStep(pageIndex, pageSize);
      if (!step) {
        throw new PortalContractDriftError(
          `mymrc-backfill: ${objectApiName}/${listViewApiName || '(default)'} pageIndex ${pageIndex} is past the ` +
            `${SORT_FLIP_STEP_COUNT}-step sort-flip plan (max coverage ${SORT_FLIP_STEP_COUNT * pageSize} records). ` +
            `Either the list view exceeds that (unreachable via the getItems offset ceiling — needs a non-getItems ` +
            `transport) or a stale pre-sort-flip cursor is being resumed (reset the cursor to re-run). Refusing to mark complete.`,
        );
      }

      const actionId = `bf-${actionSeq++}`;
      const formFields = buildGetItemsFormFields(
        framework,
        {
          entityName: objectApiName,
          filterName,
          offset: step.offset,
          pageSize,
          sortBy: step.sortBy,
          getCount: true,
        },
        actionId,
      );

      const body = await session.postGetItems(formFields);
      let parsed;
      try {
        parsed = parseGetItemsResponse(body);
      } catch (err) {
        // A drift/parse failure on a logged-out session is really an AUTH failure —
        // map it so the engine treats it as transient (clean cursor, resume after
        // re-auth) instead of a persisted wedge.
        if (await session.isLoggedOut()) {
          await session.purgeState();
          throw new AuthFailedError(
            `mymrc-backfill: logged out paging ${objectApiName}/${listViewApiName || '(default)'} at page ${pageIndex} ` +
              `(sort ${step.sortBy}, offset ${step.offset})`,
          );
        }
        throw err;
      }

      const total = parsed.totalCount;
      // Coverage overflow: a view too large for sort-flip to fully reach. Keep
      // paging every reachable window (so the ≤8000 rows still land in the mirror),
      // but NEVER let a page report drained — force the engine to the plan wall,
      // where `sortFlipStep` returns null and we wedge LOUD (above). This is the
      // "do NOT silently cap" guarantee.
      if (total !== null && sortFlipExceedsCoverage(total, pageSize)) {
        log(
          'warn',
          `mymrc-backfill: ${objectApiName}/${listViewApiName || '(default)'} totalCount=${total} EXCEEDS sort-flip ` +
            `coverage (${SORT_FLIP_STEP_COUNT * pageSize}); paging reachable windows then wedging LOUD (a middle rank ` +
            `band is unreachable via the getItems offset ceiling)`,
        );
        return { ids: parsed.recordIds, hasMoreData: true, totalCount: total };
      }

      // `totalCount` decides how many steps cover the view. If it is somehow absent
      // (contract drift — it is reliably present live), run the FULL plan rather
      // than risk under-covering: over-paging is idempotent, silent loss is not.
      const lastNeeded =
        total !== null ? sortFlipLastPageIndex(total, pageSize) : SORT_FLIP_STEP_COUNT - 1;
      if (total === null) {
        log(
          'warn',
          `mymrc-backfill: ${objectApiName}/${listViewApiName || '(default)'} getCount returned no totalCount — running full sort-flip plan`,
        );
      }
      const hasMoreData = pageIndex < lastNeeded;
      log(
        'info',
        `mymrc-backfill: ${objectApiName}/${listViewApiName || '(default)'} page ${pageIndex} (sort ${step.sortBy}, offset ${step.offset}) → ` +
          `${parsed.recordIds.length} ids · totalCount=${total ?? 'n/a'} · lastNeeded=${lastNeeded} · hasMoreData=${hasMoreData}`,
      );
      return { ids: parsed.recordIds, hasMoreData, totalCount: total };
    },
  };
}

// ── Playwright adapter (the only untested-by-unit shell) ─────────────────────

const AURA_URL_RE = /\/s\/sfsites\/aura/i;
const PORTAL_ORIGIN = 'https://mrc-us.my.site.com';
const CAPTURE_SETTLE_MS = 4_000;
// ADR-0103 — a mid-run heal invalidates the page a capture pass is bound to, so
// the pass has to be re-run on the healed page. TWO passes is the whole budget:
// pass 1 may be healed away, pass 2 runs on a session `ensureAuthenticated` has
// already PROVEN authenticated (it throws AuthFailedError otherwise), so a third
// pass could only chase a portal that is dropping us faster than we can log in —
// which is the deadman's job to report, not this loop's to absorb.
const MAX_CAPTURE_PASSES = 2;

/**
 * Implement {@link BackfillSession} over an {@link AdminSession} (the shared,
 * self-healing admin browser session). This is the sole layer that touches raw
 * Playwright — kept minimal and hand-verified on CHAD:
 *   - `captureListPage` navigates the list page and intercepts the OUTGOING aura
 *     requests (for the framework envelope + getItems request messages) AND the
 *     RESPONSES (for the correlate step), plus the endpoint URL to replay against.
 *   - `postGetItems` replays via the context's own request API, so the session
 *     cookie jar authenticates the POST with no manual cookie handling.
 * Detail is no longer fetched here (the racy per-record `/s/detail/<id>`
 * interception is dead): the batched getRecordWithFields transport
 * (record-fields-client.ts) captures billing fields via `captureListPage`'s
 * envelope.
 */
export function playwrightBackfillSession(
  admin: AdminSession,
  log: Logger = noopLog,
): BackfillSession {
  let endpointUrl: string | null = null;

  return {
    async captureListPage(path) {
      const url = `${PORTAL_ORIGIN}${path}`;
      const requestMessages: string[] = [];
      const responseBodies: string[] = [];
      let framework: AuraFrameworkParams | null = null;

      const onRequest = (req: PwRequest): void => {
        if (req.method() !== 'POST' || !AURA_URL_RE.test(req.url())) return;
        const postData = req.postData();
        if (!postData) return;
        const { message, framework: fw } = parseAuraPostData(postData);
        if (fw && !framework) framework = fw;
        if (message && messageIsGetItems(message)) {
          requestMessages.push(message);
          if (!endpointUrl) endpointUrl = req.url();
        }
      };
      const onResponse = (resp: PwResponse): void => {
        if (!AURA_URL_RE.test(resp.url())) return;
        resp
          .text()
          .then((t) => responseBodies.push(t))
          .catch(() => undefined);
      };

      // ADR-0103 — `admin.getPage()` is re-read INSIDE every pass, never cached
      // across `ensureAuthenticated`. A mid-run heal (`rebuildAndLogin`) closes the
      // context and opens a NEW page, which broke this capture two ways at once:
      //   1. the loud one — `page.waitForTimeout` on the closed page threw
      //      "Target page, context or browser has been closed", failing the feed;
      //   2. the quiet one — our aura listeners were still bound to the DEAD page,
      //      and the heal's own re-navigation to `url` happened with nothing
      //      listening, so a capture that survived (1) would return EMPTY. Empty is
      //      worse than failed: it under-syncs billing data without a word.
      // So a healed pass is DISCARDED and replayed on the healed page, listeners
      // and all, rather than patched up in place.
      let healed = false;
      for (let pass = 1; pass <= MAX_CAPTURE_PASSES; pass++) {
        const page = admin.getPage();
        // A replayed pass must not inherit the healed-away pass's partial capture.
        requestMessages.length = 0;
        responseBodies.length = 0;
        framework = null;
        healed = false;

        page.on('request', onRequest);
        page.on('response', onResponse);
        try {
          await admin.gotoWithRetry(url, 'networkidle');
          await admin.ensureAuthenticated(url);
          // Identity, not a flag: `ensureAuthenticated` heals silently, and the only
          // honest evidence that it did is that the live page is no longer ours.
          healed = admin.getPage() !== page;
          if (!healed) await page.waitForTimeout(CAPTURE_SETTLE_MS);
        } finally {
          // `off` is a synchronous emitter removal — safe on an already-closed page.
          page.off('request', onRequest);
          page.off('response', onResponse);
        }
        if (!healed) break;
        log(
          'warn',
          `mymrc-backfill: session healed mid-capture ${path} — replaying capture on the healed page (pass ${pass}/${MAX_CAPTURE_PASSES})`,
        );
      }
      if (healed) {
        // Budget exhausted and the LAST pass was still healed away. That pass did
        // capture traffic — but `ensureAuthenticated` only heals when the page reads
        // logged-OUT, so that traffic came off an unauthenticated page and must not
        // be replayed. Hand back an EMPTY capture: `fetchListPage` turns a missing
        // envelope into a loud PortalContractDriftError (a resumable wedge), which
        // is the honest outcome. Trusting it would silently under-sync billing.
        requestMessages.length = 0;
        responseBodies.length = 0;
        framework = null;
        log(
          'warn',
          `mymrc-backfill: capture ${path} ABANDONED — session healed on every pass; returning an empty capture so the replay wedges loud`,
        );
      }
      log(
        'info',
        `mymrc-backfill: capture ${path} — ${requestMessages.length} getItems req, ${responseBodies.length} aura resp`,
      );
      return { framework, requestMessages, responseBodies };
    },

    async postGetItems(formFields) {
      const endpoint = endpointUrl ?? `${PORTAL_ORIGIN}/s/sfsites/aura`;
      const resp = await admin.getContext().request.post(endpoint, {
        form: formFields,
        headers: {
          'X-SFDC-Request-Id': 'dr3-backfill',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
      });
      return resp.text();
    },

    async isLoggedOut() {
      return admin.isLoginPage();
    },

    async purgeState() {
      await admin.purgeState();
    },
  };
}
