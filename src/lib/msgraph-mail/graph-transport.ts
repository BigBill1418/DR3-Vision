// ADR-0046 D1 — the LIVE Graph-mail transport (client-credentials + plain fetch).
//
// Deliberately NOT the heavy @microsoft/microsoft-graph-client SDK — same choice
// as the EIA billing client: `@azure/identity` for the token, then raw fetch
// against graph.microsoft.com v1.0. `Mail.ReadWrite` (C9-D6), scoped by
// ApplicationAccessPolicy to the single shared mailbox (org-wide read is
// unacceptable — that scoping is an IT/tenant concern, enforced outside this code).
//
// Delta tokens are treated as OPAQUE: we persist the full `@odata.deltaLink` /
// `@odata.nextLink` URL and GET it directly next poll (the Graph-recommended
// pattern). A 410 Gone (token expired) surfaces as a resync (caller re-lists from
// the base delta endpoint). This module is UNTESTED by unit tests (no creds in
// CI) — the mock is the tested path; correctness here is by review + the live
// flip. NEVER a send method.

import { ClientSecretCredential } from '@azure/identity';
import { AuthFailedError, GraphContractDriftError, type GraphMailConfig, type MailTransport } from './transport';
import { normalizeAttachments, normalizeMessage, type RawAttachment, type RawMessage } from './normalize';
import type { DeltaResult, MailMessage, NormAttachment } from './types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const REQUEST_TIMEOUT_MS = 30_000;

const MESSAGE_SELECT =
  'id,internetMessageId,conversationId,receivedDateTime,from,sender,subject,bodyPreview,hasAttachments';

interface TokenCache {
  token: string;
  expiresAt: number;
}

/** Live Graph transport bound to one mailbox. Source + processed folders are ids/well-known names. */
export function graphTransport(
  config: GraphMailConfig,
  opts: { processedFolder?: string } = {},
): MailTransport {
  const credential = new ClientSecretCredential(config.tenantId, config.clientId, config.secret);
  const mailboxPath = `${GRAPH_BASE}/users/${encodeURIComponent(config.mailbox)}`;
  let tokenCache: TokenCache | null = null;

  async function getToken(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
    let res;
    try {
      res = await credential.getToken(GRAPH_SCOPE);
    } catch (e) {
      throw new AuthFailedError(`token acquisition failed: ${describe(e)}`);
    }
    if (!res?.token) throw new AuthFailedError('token acquisition returned no token');
    tokenCache = { token: res.token, expiresAt: res.expiresOnTimestamp ?? now + 300_000 };
    return tokenCache.token;
  }

  async function graphFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'outlook.body-content-type="html"',
          ...(init.headers ?? {}),
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw new AuthFailedError(`Graph returned ${res.status} for ${redactUrl(url)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function graphJson(url: string): Promise<Record<string, unknown>> {
    const res = await graphFetch(url);
    if (!res.ok) {
      throw new GraphContractDriftError(`Graph GET ${redactUrl(url)} → HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async function listDelta(folder: string, deltaToken: string | null): Promise<DeltaResult> {
    // deltaToken (when present) is the opaque full deltaLink URL from last poll.
    let url =
      deltaToken ??
      `${mailboxPath}/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=${MESSAGE_SELECT}`;
    const resynced = deltaToken === null;
    const messages: MailMessage[] = [];
    let nextDelta: string | null = null;
    // Follow @odata.nextLink pages; the last page carries @odata.deltaLink.
    for (let guard = 0; guard < 1000; guard++) {
      let body: Record<string, unknown>;
      try {
        body = await graphJson(url);
      } catch (e) {
        // 410 Gone → token expired: restart from the base endpoint (resync).
        if (deltaToken && e instanceof GraphContractDriftError && /HTTP 410/.test(e.message)) {
          return listDelta(folder, null);
        }
        throw e;
      }
      const value = body['value'];
      if (!Array.isArray(value)) {
        throw new GraphContractDriftError(`delta response missing "value" array (folder ${folder})`);
      }
      for (const raw of value) messages.push(normalizeMessage(raw as RawMessage));
      const next = body['@odata.nextLink'];
      const delta = body['@odata.deltaLink'];
      if (typeof next === 'string') {
        url = next;
        continue;
      }
      if (typeof delta === 'string') {
        nextDelta = delta;
        break;
      }
      throw new GraphContractDriftError(`delta response missing both @odata.nextLink and @odata.deltaLink (folder ${folder})`);
    }
    if (nextDelta === null) throw new GraphContractDriftError(`delta paging did not terminate (folder ${folder})`);
    // Delta feeds surface tombstones (@removed) as items lacking a body; the
    // pipeline only acts on messages with an internetMessageId, so filter here.
    return { messages: messages.filter((m) => m.internetMessageId !== ''), deltaToken: nextDelta, resynced };
  }

  async function getMessage(id: string): Promise<MailMessage> {
    const html = await graphJson(`${mailboxPath}/messages/${encodeURIComponent(id)}?$select=${MESSAGE_SELECT},body`);
    const msg = normalizeMessage(html as RawMessage);
    // Second fetch for the text/plain part (Prefer text) — best-effort; falls back
    // to the bodyPreview already captured by normalizeMessage.
    try {
      const textRes = await graphFetch(`${mailboxPath}/messages/${encodeURIComponent(id)}?$select=body`, {
        headers: { Prefer: 'outlook.body-content-type="text"' },
      });
      if (textRes.ok) {
        const textBody = (await textRes.json()) as { body?: { content?: string } };
        const t = textBody.body?.content;
        if (typeof t === 'string' && t.length > 0) msg.bodyText = t;
      }
    } catch {
      // keep the bodyPreview fallback
    }
    return msg;
  }

  async function listAttachments(id: string): Promise<NormAttachment[]> {
    const body = await graphJson(
      `${mailboxPath}/messages/${encodeURIComponent(id)}/attachments?$expand=microsoft.graph.itemAttachment/item`,
    );
    const value = body['value'];
    if (!Array.isArray(value)) {
      throw new GraphContractDriftError(`attachments response missing "value" array (message ${id})`);
    }
    return normalizeAttachments(value as RawAttachment[]);
  }

  async function moveMessage(id: string, destFolder: string): Promise<string> {
    const dest = opts.processedFolder ?? destFolder;
    const res = await graphFetch(`${mailboxPath}/messages/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ destinationId: dest }),
    });
    if (!res.ok) throw new GraphContractDriftError(`move message ${id} → ${dest} failed: HTTP ${res.status}`);
    const moved = (await res.json()) as { id?: string };
    return typeof moved.id === 'string' ? moved.id : id;
  }

  return { mode: 'graph', listDelta, getMessage, listAttachments, moveMessage };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** Strip query strings from a URL before it reaches a log — delta tokens are sensitive-ish. */
function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}
