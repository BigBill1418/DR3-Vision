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
    parentItemId: str(parent?.['id']),
    parentPath: str(parent?.['path']),
    deleted: rec(item['deleted']) !== null,
  };
}

// ── the client ──────────────────────────────────────────────────────────────

export function docIngestGraph(
  prisma: PrismaClient,
  options: DocIngestGraphOptions = {},
): DocIngestGraph {
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
