// ADR-0057 Phase 1 (D3) — the OFFSET-paginating BackfillPortalClient.
//
// This is the production adapter the windowed backfill engine (backfill.ts) was
// built to consume: `fetchListPage(objectApiName, listViewApiName, pageIndex)`.
// It maps the engine's 0-based `pageIndex` onto the CONFIRMED getItems `offset`
// (`offsetForPage` = pageIndex * pageSize) and replays the Aura getItems action
// against `/s/sfsites/aura`, reusing the live aura framework envelope the browser
// itself sent on the list page (immune to fwuid drift) — the offset-replay path
// (ladder #1), chosen over DOM infinite-scroll for DETERMINISM: page N is a pure
// function of the cursor, so the engine's DB-durable `last_page_index` resume is
// exact and a page is never skipped or double-fetched.
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
import {
  AuthFailedError,
  PortalContractDriftError,
  detailUrl,
  extractRecord,
  type AdminSession,
} from './portal-client';
import {
  BACKFILL_LIST_VIEWS,
  buildGetItemsFormFields,
  correlateCapturedListViews,
  DEFAULT_PAGE_SIZE,
  messageIsGetItems,
  offsetForPage,
  parseAuraPostData,
  parseGetItemsResponse,
  resolveFilterName,
  type AuraFrameworkParams,
  type CapturedListView,
  type ListViewBinding,
} from './list-page';
import type { SfRecord } from './types';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

// ── list-page routing (DR3-internal, mirrors OBJECT_NAV_SLUGS) ────────────────
//
// Which authenticated list page to load to (a) capture the aura envelope and (b)
// resolve a list-view id at runtime. Keyed by the DR3 `list_view_api_name` slug
// because the two Materials views live on SEPARATE nav pages, while the two Haul
// views share `/s/hauls`. These bindings are stable DR3 conventions; a redesign
// that moves them fails LOUD (no capture → PortalContractDriftError), never silent.
const LIST_PAGE_BY_SLUG: Readonly<Record<string, string>> = {
  docking_appointments_rc: '/s/hauls',
  consumer_drop_off_rc: '/s/hauls',
  processed_active: '/s/processed-materials',
  outbound_active: '/s/outbound-materials',
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
  /** Fetch one record's detail representation (throws AuthFailedError when logged out). */
  fetchRecordDetail(recordId: string): Promise<SfRecord>;
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
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
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
      if (!capturedViews.some((c) => c.entityName === v.entityName && c.filterName === v.filterName)) {
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

      const offset = offsetForPage(pageIndex, pageSize);
      const actionId = `bf-${actionSeq++}`;
      const formFields = buildGetItemsFormFields(
        framework,
        { entityName: objectApiName, filterName, offset, pageSize },
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
            `mymrc-backfill: logged out paging ${objectApiName}/${listViewApiName || '(default)'} at offset ${offset}`,
          );
        }
        throw err;
      }
      log(
        'info',
        `mymrc-backfill: ${objectApiName}/${listViewApiName || '(default)'} offset ${offset} → ${parsed.recordIds.length} ids (hasMoreData=${parsed.hasMoreData})`,
      );
      return { ids: parsed.recordIds, hasMoreData: parsed.hasMoreData };
    },

    async fetchRecordDetail(recordId): Promise<SfRecord> {
      return session.fetchRecordDetail(recordId);
    },
  };
}

// ── Playwright adapter (the only untested-by-unit shell) ─────────────────────

const AURA_URL_RE = /\/s\/sfsites\/aura/i;
const PORTAL_ORIGIN = 'https://mrc-us.my.site.com';
const CAPTURE_SETTLE_MS = 4_000;

/**
 * Implement {@link BackfillSession} over an {@link AdminSession} (the shared,
 * self-healing admin browser session). This is the sole layer that touches raw
 * Playwright — kept minimal and hand-verified on CHAD:
 *   - `captureListPage` navigates the list page and intercepts the OUTGOING aura
 *     requests (for the framework envelope + getItems request messages) AND the
 *     RESPONSES (for the correlate step), plus the endpoint URL to replay against.
 *   - `postGetItems` replays via the context's own request API, so the session
 *     cookie jar authenticates the POST with no manual cookie handling.
 *   - `fetchRecordDetail` reuses the interception detail path (collectAura +
 *     extractRecordDetail), with the same logged-out guard as the steady-state client.
 */
export function playwrightBackfillSession(admin: AdminSession, log: Logger = noopLog): BackfillSession {
  let endpointUrl: string | null = null;

  return {
    async captureListPage(path) {
      const url = `${PORTAL_ORIGIN}${path}`;
      const requestMessages: string[] = [];
      const responseBodies: string[] = [];
      let framework: AuraFrameworkParams | null = null;
      const page = admin.getPage();

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

      page.on('request', onRequest);
      page.on('response', onResponse);
      try {
        await admin.gotoWithRetry(url, 'networkidle');
        await admin.ensureAuthenticated(url);
        await page.waitForTimeout(CAPTURE_SETTLE_MS);
      } finally {
        page.off('request', onRequest);
        page.off('response', onResponse);
      }
      log('info', `mymrc-backfill: capture ${path} — ${requestMessages.length} getItems req, ${responseBodies.length} aura resp`);
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

    async fetchRecordDetail(recordId) {
      const bodies = await admin.collectAura(detailUrl(recordId));
      if (await admin.isLoginPage()) {
        await admin.purgeState();
        throw new AuthFailedError(`mymrc-backfill: logged out during detail ${recordId}`);
      }
      return extractRecord(bodies, recordId);
    },

    async isLoggedOut() {
      return admin.isLoginPage();
    },

    async purgeState() {
      await admin.purgeState();
    },
  };
}
