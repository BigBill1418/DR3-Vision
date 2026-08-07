// ADR-0067 §3.2 — the Graph surface the ingestion pipeline uses.
//
// Every call goes through `acquireAccessToken(prisma)` — the ONE auth path
// (Amendment A). That matters more than it looks: `acquireAccessToken` halts on
// `reauth_required`, returns the cached token when it is valid, and PERSISTS the
// rotated refresh token when it is not. A client that fetched its own token
// would drop the rotated one and silently kill the chain on the next refresh.
//
// Raw `fetch` against graph.microsoft.com/v1.0, matching the AP mail (ADR-0046)
// and Graph Files (ADR-0049) transports — deliberately not the heavyweight
// @microsoft/microsoft-graph-client SDK.
//
// READ-ONLY over files. The only writes this module performs are subscription
// lifecycle calls (create / renew / delete), which touch no document.

import type { PrismaClient } from '@prisma/client';
import { acquireAccessToken } from './access-token';
import {
  DOC_INGEST_DOWNLOAD_TIMEOUT_MS,
  DOC_INGEST_MAX_PAGES,
  DOC_INGEST_REQUEST_TIMEOUT_MS,
} from './pipeline-config';
import type { FetchLike } from './oauth';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * A Graph call failed in a way that says nothing about permissions — a 5xx, a
 * 429, a socket error. Transient: retried on the next sweep, never latched.
 */
export class DocIngestGraphError extends Error {
  override readonly name = 'DocIngestGraphError';
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Graph said 403 / 401-on-a-resource. The token is fine (that would have thrown
 * from `acquireAccessToken`); THIS ITEM is not readable. Almost always a revoked
 * share, which is a `doc_sources.state = access_denied` — deliberately NOT
 * folded into "disappeared".
 */
export class DocIngestAccessDeniedError extends Error {
  override readonly name = 'DocIngestAccessDeniedError';
  constructor(resource: string) {
    super(`access denied for ${resource}`);
  }
}

/** Graph said 404. The item is gone from the drive (deleted, or moved out of reach). */
export class DocIngestNotFoundError extends Error {
  override readonly name = 'DocIngestNotFoundError';
  constructor(resource: string) {
    super(`not found: ${resource}`);
  }
}

/**
 * The operator handed us something that is not a usable sharing URL — wrong
 * host, not https, or a string Graph answered 400 for.
 *
 * Deliberately NOT a {@link DocIngestGraphError}: that class means "transient,
 * retry later", and retrying a malformed link forever produces nothing. This one
 * is terminal and its message is written to be READ BY BILL, not by a log
 * scraper — the operator is the only party who can fix it, by pasting a
 * different link.
 */
export class DocIngestSharingUrlError extends Error {
  override readonly name = 'DocIngestSharingUrlError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * A delta token Graph will not accept any more (`resyncRequired`). Handled by a
 * FULL re-enumeration, never by a silent skip — a dropped delta window is
 * exactly how a change goes missing forever.
 */
export class DocIngestDeltaResyncError extends Error {
  override readonly name = 'DocIngestDeltaResyncError';
  constructor(message: string) {
    super(message);
  }
}

/** The subset of a Graph `driveItem` the pipeline actually uses. */
export interface GraphDriveItem {
  id: string;
  driveId: string;
  name: string;
  isFolder: boolean;
  webUrl: string | null;
  ctag: string | null;
  etag: string | null;
  size: number | null;
  contentType: string | null;
  lastModifiedAt: string | null;
  lastModifiedBy: string | null;
  ownerUpn: string | null;
  /**
   * `createdBy.user` — the account that CREATED the document, i.e. its true
   * owner. Split out from {@link ownerUpn} because the two facets carry
   * different authority and the owner-left inference (discovery.ts) depends on
   * the distinction: `sharedWithMe`'s `remoteItem` facet carries NEITHER, so
   * `ownerUpn` is null for every auto-discovered source, while a direct
   * `GET /drives/{driveId}/items/{itemId}` DOES return `createdBy`.
   *
   * Optional rather than required so existing GraphDriveItem literals (fixtures,
   * hand-built stubs) keep compiling — absent means "this projection had no
   * createdBy facet", which is exactly what null means too.
   */
  createdByUpn?: string | null;
  /** `shared.owner.user` — the drive owner as Graph reports it on a share facet. */
  sharedOwnerUpn?: string | null;
  parentItemId: string | null;
  parentPath: string | null;
  /** Present on a delta page when the item was removed. */
  deleted: boolean;
}

export interface GraphSubscription {
  id: string;
  expirationDateTime: string;
  resource: string;
}

export interface DeltaPage {
  items: GraphDriveItem[];
  /** Present on the LAST page — the token to replay next time. */
  deltaLink: string | null;
}

export interface DocIngestGraphOptions {
  fetchImpl?: FetchLike;
}

export interface DocIngestGraph {
  /**
   * Everything shared with the service account.
   *
   * ⚠ Backed by `GET /me/drive/sharedWithMe`, which Microsoft DEPRECATED in
   * November 2025 — degraded until November 2026, then it stops returning data,
   * with no documented one-to-one replacement. See `SHARED_WITH_ME_SUNSET`.
   */
  listSharedWithMe(): Promise<GraphDriveItem[]>;
  listChildren(driveId: string, itemId: string): Promise<GraphDriveItem[]>;
  getItem(driveId: string, itemId: string): Promise<GraphDriveItem>;
  /** `deltaLink` null ⇒ start a full enumeration of the drive. */
  deltaForDrive(driveId: string, deltaLink: string | null): Promise<DeltaPage>;
  /**
   * Stream an item's bytes with a hard cap. Throws {@link DocIngestOversizeError}
   * the moment the cap is passed — it never returns a truncated buffer, because
   * a truncated workbook parses cleanly and yields wrong numbers.
   */
  downloadItem(driveId: string, itemId: string, maxBytes: number): Promise<Uint8Array>;
  createSubscription(args: {
    resource: string;
    notificationUrl: string;
    clientState: string;
    expiresAt: Date;
  }): Promise<GraphSubscription>;
  renewSubscription(subscriptionId: string, expiresAt: Date): Promise<GraphSubscription>;
  deleteSubscription(subscriptionId: string): Promise<void>;
}

/**
 * Resolving an operator-supplied document URL.
 *
 * Deliberately a SEPARATE interface from {@link DocIngestGraph} rather than one
 * more method on it. Two reasons, and the second is the load-bearing one:
 *
 *   1. Nothing in the automated pipeline calls this. The sweep, the delta walk,
 *      discovery and ingest all work from identities they already hold; a URL is
 *      something only a human can supply. Keeping it out of the sweep's Graph
 *      surface says so in the type.
 *   2. `DocIngestGraph` is stubbed in four existing test files. Widening it
 *      would force every one of those stubs to grow a method they will never
 *      call, which is how an interface quietly becomes a place to put things.
 *
 * `docIngestGraph()` returns both, so a caller that needs both just gets them.
 */
export interface DocIngestSharingResolver {
  /**
   * Resolve a SharePoint / OneDrive document URL to the driveItem behind it via
   * `GET /shares/u!{token}/driveItem`.
   *
   * The operator-driven counterpart to `listSharedWithMe`, and it exists because
   * that endpoint is both deprecated AND, in this tenant, under-reporting: it
   * returns one item while more documents are genuinely shared with the service
   * account. `/shares` reaches the ones it misses — including an
   * Outlook-attachment share, which never appears in a shared-with-me list at
   * all.
   *
   * READ-ONLY, and that is enforced by an omission: the documented
   * `Prefer: redeemSharingLink` header would grant the caller DURABLE access to
   * the item — a permission change — so it is deliberately never sent. Resolving
   * a link must observe the tenant, never alter it.
   *
   * Throws {@link DocIngestSharingUrlError} (unusable link),
   * {@link DocIngestAccessDeniedError} (403 — not shared with us) or
   * {@link DocIngestNotFoundError} (404 — gone). Those three stay apart because
   * they need three different things from the operator.
   */
  resolveSharingUrl(webUrl: string): Promise<GraphDriveItem>;
}

/**
 * Tenant SEARCH — the reachability probe (ADR-0080 Phase 1).
 *
 * A THIRD interface, for the same reason `DocIngestSharingResolver` is a second
 * one: nothing in the ingest path calls it, and `DocIngestGraph` is stubbed in
 * five test files that would otherwise grow a method they never call.
 *
 * ── What this answers, and what it does NOT ─────────────────────────────────
 * `POST /search/query` returns everything the SIGNED-IN IDENTITY CAN READ — not
 * everything shared WITH it. Microsoft is explicit: "Users cannot access more
 * items in a search than they can otherwise obtain from a corresponding GET
 * operation with the same permissions." Vision holds `Sites.Read.All`, so the
 * unscoped answer is the whole tenant: measured at 11,442 items on 2026-08-07.
 *
 * That is why this is NOT wired as the discovery enumeration and must never be.
 * Watching what Search returns would mean ingesting Night Shelter intake packets
 * and W-9 lists. It is a COMPARISON input — "what can we see that we are not
 * watching" — and the gap it finds is surfaced for a human, never auto-adopted.
 *
 * READ-ONLY despite being an HTTP POST: `/search/query` takes its query in a
 * body because it is too big for a query string. It mutates nothing.
 */
export interface DocIngestSearch {
  /**
   * Run one KQL query over `driveItem`, newest-relevance first.
   *
   * `truncated` is returned rather than swallowed: a scan that silently saw only
   * the first page would UNDER-report the gap, which is the precise failure this
   * whole feature exists to end.
   */
  searchDriveItems(
    kql: string,
    limit: number,
  ): Promise<{ items: GraphDriveItem[]; total: number | null; truncated: boolean }>;
}

/** The file exceeded the byte cap. Pages; never silently truncates. */
export class DocIngestOversizeError extends Error {
  override readonly name = 'DocIngestOversizeError';
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number,
  ) {
    super(`file exceeds the ${maxBytes}-byte ingestion cap (saw at least ${observedBytes})`);
  }
}

// ── driveItem projection ────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Project a raw Graph driveItem, transparently unwrapping the `remoteItem`
 * facet.
 *
 * `sharedWithMe` returns a LOCAL stub whose own `id` belongs to the service
 * account's drive; the real, IMMUTABLE identity of the shared document is inside
 * `remoteItem` (its `id` plus `parentReference.driveId`). Keying on the stub
 * would make every source look like it lived in one drive and would break the
 * moment the same file arrived by a second route — so the unwrap happens HERE,
 * once, and nothing downstream ever sees a stub.
 */
export function projectDriveItem(raw: unknown, fallbackDriveId?: string): GraphDriveItem | null {
  const top = rec(raw);
  if (!top) return null;

  const remote = rec(top['remoteItem']);
  const item = remote ?? top;

  const id = str(item['id']);
  if (!id) return null;

  const parent = rec(item['parentReference']);
  const driveId = str(parent?.['driveId']) ?? fallbackDriveId ?? null;
  if (!driveId) return null;

  const fileFacet = rec(item['file']);
  const folderFacet = rec(item['folder']);
  const createdBy = rec(item['createdBy']);
  const lastModifiedBy = rec(item['lastModifiedBy']);
  const shared = rec(item['shared']);
  const sharedOwner = rec(shared?.['owner']);

  const identityUpn = (holder: Record<string, unknown> | null): string | null => {
    const user = rec(holder?.['user']);
    if (!user) return null;
    // Graph puts the UPN in `email` on some flows and `userPrincipalName` on
    // others; both are the same value for a work/school account.
    return str(user['email']) ?? str(user['userPrincipalName']) ?? str(user['displayName']);
  };

  return {
    id,
    driveId,
    name: str(item['name']) ?? '(unnamed)',
    isFolder: folderFacet !== null,
    webUrl: str(item['webUrl']),
    ctag: str(item['cTag']),
    etag: str(item['eTag']),
    size: num(item['size']),
    contentType: str(fileFacet?.['mimeType']),
    lastModifiedAt: str(item['lastModifiedDateTime']),
    lastModifiedBy: identityUpn(lastModifiedBy),
    // Who shared it. `shared.owner` is the authoritative answer; `createdBy` is
    // the best-effort fallback. Recorded because D8 requires the "owner left"
    // alert to NAME the previous owner — after the account is gone, this stored
    // value is the only place that name still exists.
    ownerUpn: identityUpn(sharedOwner) ?? identityUpn(createdBy),
    // Both facets kept SEPARATELY as well, so a caller that needs "who created
    // this" specifically is not forced to accept `shared.owner` winning. Neither
    // is ever `shared.sharedBy`: that is who handed the file over, not who owns
    // it, and conflating them would make the owner-left inference fire on the
    // wrong person's departure.
    createdByUpn: identityUpn(createdBy),
    sharedOwnerUpn: identityUpn(sharedOwner),
    parentItemId: str(parent?.['id']),
    parentPath: str(parent?.['path']),
    deleted: rec(item['deleted']) !== null,
  };
}

// ── sharing-URL encoding ────────────────────────────────────────────────────

/**
 * Encode a sharing URL into the `u!` share token `/shares/{id}` expects.
 *
 * Microsoft's documented algorithm, verbatim
 * (https://learn.microsoft.com/graph/api/shares-get?view=graph-rest-1.0#encoding-sharing-urls):
 *   1. base64-encode the URL (UTF-8 bytes);
 *   2. convert to UNPADDED base64url — strip trailing `=`, `/`→`_`, `+`→`-`;
 *   3. prefix `u!`.
 *
 * Steps 2 and 3 are the whole reason this is a named function with its own
 * tests. A plain `encodeURIComponent` looks like it works — most SharePoint URLs
 * base64-encode to an alphabet with no `+` or `/` in it — and then silently 400s
 * on the one URL whose query string happens to produce them. The failure is
 * data-dependent, so it cannot be caught by trying it once by hand.
 */
export function encodeSharingUrl(webUrl: string): string {
  const base64 = Buffer.from(webUrl, 'utf8').toString('base64');
  return `u!${base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

/** Hosts a Microsoft 365 document link can legitimately live on. */
function isSupportedSharingHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'sharepoint.com' ||
    h.endsWith('.sharepoint.com') ||
    h === 'onedrive.live.com' ||
    h === '1drv.ms'
  );
}

/**
 * Refuse a URL that cannot possibly be a Microsoft document link BEFORE spending
 * a Graph call on it. Not a security boundary — the URL is never fetched by us,
 * only handed to Graph — but it turns "Graph said 400" into an answer the
 * operator can act on, and it stops a pasted Google Drive / Dropbox link from
 * being silently attempted against the tenant.
 */
function assertSupportedSharingUrl(webUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(webUrl);
  } catch {
    throw new DocIngestSharingUrlError(
      'That is not a URL. Paste the full web address of the document, starting with https://.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new DocIngestSharingUrlError('The document link must start with https://.');
  }
  if (!isSupportedSharingHost(parsed.hostname)) {
    throw new DocIngestSharingUrlError(
      `${parsed.hostname} is not a Microsoft 365 document host. Vision can only register ` +
        'SharePoint or OneDrive links (*.sharepoint.com, onedrive.live.com, 1drv.ms).',
    );
  }
}

// ── the client ──────────────────────────────────────────────────────────────

export function docIngestGraph(
  prisma: PrismaClient,
  options: DocIngestGraphOptions = {},
): DocIngestGraph & DocIngestSharingResolver & DocIngestSearch {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));

  async function request(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const token = await acquireAccessToken(prisma, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? DOC_INGEST_REQUEST_TIMEOUT_MS,
    );
    try {
      // Strip our own `timeoutMs` before handing the init to fetch — it is not a
      // RequestInit field, and passing it through would be silently ignored by
      // real fetch but visible to a test double as an unexpected key.
      const rest: RequestInit = { ...init };
      delete (rest as { timeoutMs?: number }).timeoutMs;
      return await doFetch(url, {
        ...rest,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(rest.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      throw new DocIngestGraphError(`graph request failed: ${describe(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET returning JSON, with the status taxonomy applied. */
  async function getJson(url: string): Promise<Record<string, unknown>> {
    const res = await request(url);
    await assertOk(res, redactUrl(url));
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Walk `@odata.nextLink` / `@odata.deltaLink` to the end. Bounded by
   * DOC_INGEST_MAX_PAGES so a pathological or looping response can never spin
   * forever inside one sweep.
   */
  async function paginate(
    firstUrl: string,
    fallbackDriveId?: string,
  ): Promise<{ items: GraphDriveItem[]; deltaLink: string | null }> {
    const items: GraphDriveItem[] = [];
    let url: string | null = firstUrl;
    let deltaLink: string | null = null;

    for (let page = 0; page < DOC_INGEST_MAX_PAGES && url; page += 1) {
      const body: Record<string, unknown> = await getJson(url);
      const value = body['value'];
      if (Array.isArray(value)) {
        for (const raw of value) {
          const projected = projectDriveItem(raw, fallbackDriveId);
          if (projected) items.push(projected);
        }
      }
      const delta = body['@odata.deltaLink'];
      if (typeof delta === 'string') deltaLink = delta;
      const next = body['@odata.nextLink'];
      url = typeof next === 'string' ? next : null;
    }
    return { items, deltaLink };
  }

  return {
    async listSharedWithMe() {
      // `allowexternal=true` so a document shared from a partner tenant is not
      // invisible. Vision must not quietly ignore a share just because it came
      // from outside SVdP — an unseen share and a missing document look the same
      // from here, and only one of them is anybody's fault.
      const { items } = await paginate(`${GRAPH_BASE}/me/drive/sharedWithMe?allowexternal=true`);
      return items;
    },

    async listChildren(driveId, itemId) {
      const url =
        `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}` +
        `/items/${encodeURIComponent(itemId)}/children?$top=200`;
      const { items } = await paginate(url, driveId);
      return items;
    },

    async getItem(driveId, itemId) {
      const url = `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
      const body = await getJson(url);
      const projected = projectDriveItem(body, driveId);
      if (!projected) throw new DocIngestGraphError(`unreadable driveItem body for ${itemId}`);
      return projected;
    },

    async resolveSharingUrl(webUrl) {
      const trimmed = webUrl.trim();
      assertSupportedSharingUrl(trimmed);

      // No `Prefer: redeemSharingLink` — see the interface doc. Peeking at a
      // link's metadata is the entire job; redeeming it would grant durable
      // access, which is a write this integration has no business performing.
      const res = await request(`${GRAPH_BASE}/shares/${encodeSharingUrl(trimmed)}/driveItem`);

      // The three failures are kept APART because they need three different
      // things from the operator, and collapsing them into "couldn't add it"
      // sends Bill to re-copy a link that was fine.
      if (res.status === 400) {
        throw new DocIngestSharingUrlError(
          'Microsoft did not recognize that link. Open the document and use its own ' +
            'Share → Copy link (or the browser address bar) — an email preview link or a ' +
            'shortened redirect will not resolve.',
        );
      }
      if (res.status === 403) {
        throw new DocIngestAccessDeniedError(
          'the document behind that link — it is not shared with the Vision service account',
        );
      }
      if (res.status === 404) {
        throw new DocIngestNotFoundError('the document behind that link');
      }
      await assertOk(res, 'GET /shares/{token}/driveItem');

      const projected = projectDriveItem(await res.json());
      if (!projected) {
        // Almost always a `parentReference.driveId` Graph declined to include,
        // which means we have no stable identity to key the source on. Refusing
        // is correct: a source keyed on a guessed drive is a duplicate waiting
        // to happen (D8).
        throw new DocIngestGraphError(
          'Microsoft resolved that link but did not return the document identity ' +
            '(drive + item id) Vision needs to watch it.',
        );
      }
      return projected;
    },

    async deltaForDrive(driveId, deltaLink) {
      const first = deltaLink ?? `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/root/delta`;
      try {
        const { items, deltaLink: next } = await paginate(first, driveId);
        return { items, deltaLink: next };
      } catch (e) {
        // Graph expires delta tokens. `resyncRequired` means "your token is too
        // old, start over" — a full re-enumeration, never a skip.
        if (e instanceof DocIngestGraphError && /resync|410/i.test(e.message)) {
          throw new DocIngestDeltaResyncError(e.message);
        }
        throw e;
      }
    },

    async downloadItem(driveId, itemId, maxBytes) {
      const url =
        `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}` +
        `/items/${encodeURIComponent(itemId)}/content`;
      const res = await request(url, { timeoutMs: DOC_INGEST_DOWNLOAD_TIMEOUT_MS });
      await assertOk(res, redactUrl(url));

      // Cheap pre-check: refuse before a byte moves when Graph declares the size.
      const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new DocIngestOversizeError(declared, maxBytes);
      }

      // STREAM and abort at the cap. Buffering first and checking after would
      // mean a 4 GB share allocates 4 GB before we decide we did not want it.
      const body = res.body;
      if (!body) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) throw new DocIngestOversizeError(buf.byteLength, maxBytes);
        return buf;
      }

      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) throw new DocIngestOversizeError(total, maxBytes);
          chunks.push(value);
        }
      } finally {
        // Release the socket on the oversize path too, or the connection leaks.
        reader.releaseLock?.();
        if (total > maxBytes) await body.cancel().catch(() => undefined);
      }

      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },

    async createSubscription({ resource, notificationUrl, clientState, expiresAt }) {
      const res = await request(`${GRAPH_BASE}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changeType: 'updated',
          notificationUrl,
          resource,
          expirationDateTime: expiresAt.toISOString(),
          clientState,
        }),
      });
      await assertOk(res, 'POST /subscriptions');
      return readSubscription(await res.json());
    },

    async renewSubscription(subscriptionId, expiresAt) {
      const res = await request(
        `${GRAPH_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
        },
      );
      await assertOk(res, `PATCH /subscriptions/${subscriptionId}`);
      return readSubscription(await res.json());
    },

    async deleteSubscription(subscriptionId) {
      const res = await request(
        `${GRAPH_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { method: 'DELETE' },
      );
      // 404 is success for a delete: the goal state is "it is not there".
      if (res.status === 404) return;
      await assertOk(res, `DELETE /subscriptions/${subscriptionId}`);
    },

    async searchDriveItems(kql, limit) {
      // Microsoft caps `size` at 1000 per page and currently honours exactly ONE
      // searchRequest per call, so this pages with `from` and stops on the
      // container's own `moreResultsAvailable` rather than guessing from counts.
      const pageSize = Math.min(limit, 200);
      const items: GraphDriveItem[] = [];
      let total: number | null = null;
      let truncated = false;

      for (let from = 0; from < limit; from += pageSize) {
        const res = await request(`${GRAPH_BASE}/search/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [
              {
                entityTypes: ['driveItem'],
                query: { queryString: kql },
                from,
                size: Math.min(pageSize, limit - from),
                fields: [
                  'name',
                  'id',
                  'parentReference',
                  'webUrl',
                  'lastModifiedDateTime',
                  'size',
                  'file',
                  'createdBy',
                ],
              },
            ],
          }),
        });
        await assertOk(res, 'POST /search/query');
        const body = (await res.json()) as Record<string, unknown>;

        // The counters live on the HITS CONTAINER, not on the response — reading
        // them off the response yields `undefined`, which would read as "no more
        // results" and silently cap every scan at one page.
        const container = rec(
          (rec((body['value'] as unknown[])?.[0])?.['hitsContainers'] as unknown[])?.[0],
        );
        const hits = container?.['hits'];
        if (total === null) total = num(container?.['total']);

        if (Array.isArray(hits)) {
          for (const hit of hits) {
            const projected = projectDriveItem(rec(hit)?.['resource']);
            if (projected) items.push(projected);
          }
        }

        const more = container?.['moreResultsAvailable'] === true;
        if (!more) break;
        // Ran out of budget with Graph still offering more: the scope is wider
        // than the cap, and the caller must be told rather than shown a number
        // that looks complete.
        if (from + pageSize >= limit) truncated = true;
      }

      return { items, total, truncated };
    },
  };
}

function readSubscription(body: unknown): GraphSubscription {
  const obj = rec(body);
  const id = str(obj?.['id']);
  const expiration = str(obj?.['expirationDateTime']);
  if (!id || !expiration) {
    throw new DocIngestGraphError('subscription response missing id/expirationDateTime');
  }
  return { id, expirationDateTime: expiration, resource: str(obj?.['resource']) ?? '' };
}

/**
 * Map an HTTP status onto the error taxonomy. The 403-vs-404 split is the whole
 * point: a revoked share and a deleted file are indistinguishable at a glance
 * and need completely different operator action.
 */
async function assertOk(res: Response, resource: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 403) throw new DocIngestAccessDeniedError(resource);
  if (res.status === 404) throw new DocIngestNotFoundError(resource);
  // Read the body for Graph's own error code (`resyncRequired`), but never let
  // a body-read failure mask the status.
  const detail = await res.text().catch(() => '');
  throw new DocIngestGraphError(
    `graph ${resource} → HTTP ${res.status}${detail ? `: ${firstLine(detail)}` : ''}`,
    res.status,
  );
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.slice(0, 300) ?? '';
}

/** Strip the query string before a URL reaches a log — download URLs carry auth state. */
function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}
