// ADR-0049 D2/D4 — the LIVE Graph Files transport (client-credentials + plain fetch).
//
// Same choice as the AP mail transport (ADR-0046): NOT the heavy
// @microsoft/microsoft-graph-client SDK — `@azure/identity` for the token, then raw
// fetch against graph.microsoft.com v1.0 with `Files.Read.All`. READ-ONLY: no
// write/move/delete path exists.
//
// Drive resolution (D4): Kelsey's personal OneDrive is addressed by UPN via
// `/users/{upn}/drive`. Files under a folder are listed with the path addressing
// form `/users/{upn}/drive/root:/{folderPath}:/children` (root children when the
// folder path is empty). A 403 from ANY call surfaces as `FilesForbiddenError` (the
// `Files.Read.All` grant is missing/unconsented) — the engine fails soft. UNTESTED
// by unit tests (no creds in CI); the mock is the tested path.

import { ClientSecretCredential } from '@azure/identity';
import {
  FilesAuthFailedError,
  FilesContractDriftError,
  FilesForbiddenError,
  type FilesTransport,
  type GraphFilesConfig,
} from './transport';
import type { DriveFile } from './types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const REQUEST_TIMEOUT_MS = 60_000; // xlsm downloads can be multi-MB
const FILE_SELECT = 'id,name,cTag,size,lastModifiedDateTime';

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface RawDriveItem {
  id?: unknown;
  name?: unknown;
  cTag?: unknown;
  size?: unknown;
  lastModifiedDateTime?: unknown;
  file?: unknown; // present on files, absent on folders
}

export function graphFilesTransport(config: GraphFilesConfig): FilesTransport {
  const credential = new ClientSecretCredential(config.tenantId, config.clientId, config.secret);
  let tokenCache: TokenCache | null = null;

  async function getToken(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
    let res;
    try {
      res = await credential.getToken(GRAPH_SCOPE);
    } catch (e) {
      throw new FilesAuthFailedError(`token acquisition failed: ${describe(e)}`);
    }
    if (!res?.token) throw new FilesAuthFailedError('token acquisition returned no token');
    tokenCache = { token: res.token, expiresAt: res.expiresOnTimestamp ?? now + 300_000 };
    return tokenCache.token;
  }

  async function graphFetch(url: string): Promise<Response> {
    const token = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (res.status === 403) throw new FilesForbiddenError(`Graph returned 403 for ${redactUrl(url)} — Files.Read.All missing?`);
      if (res.status === 401) throw new FilesAuthFailedError(`Graph returned 401 for ${redactUrl(url)}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function graphJson(url: string): Promise<Record<string, unknown>> {
    const res = await graphFetch(url);
    if (res.status === 404) return { value: [], notFound: true };
    if (!res.ok) throw new FilesContractDriftError(`Graph GET ${redactUrl(url)} → HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  function driveRoot(driveUpn: string): string {
    return `${GRAPH_BASE}/users/${encodeURIComponent(driveUpn)}/drive`;
  }

  /** `` → root children; `Daily Logs` → that folder's children (path-addressed). */
  function childrenUrl(driveUpn: string, folderPath: string): string {
    const clean = folderPath.replace(/^\/+|\/+$/g, '');
    if (clean === '') return `${driveRoot(driveUpn)}/root/children?$select=${FILE_SELECT}&$top=200`;
    const encPath = clean.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    return `${driveRoot(driveUpn)}/root:/${encPath}:/children?$select=${FILE_SELECT}&$top=200`;
  }

  function toDriveFile(raw: RawDriveItem): DriveFile | null {
    if (raw.file === undefined || raw.file === null) return null; // folder, not a file
    const id = typeof raw.id === 'string' ? raw.id : null;
    const name = typeof raw.name === 'string' ? raw.name : null;
    if (!id || !name) return null;
    return {
      id,
      name,
      ctag: typeof raw.cTag === 'string' ? raw.cTag : '',
      lastModified: typeof raw.lastModifiedDateTime === 'string' ? raw.lastModifiedDateTime : '',
      size: typeof raw.size === 'number' ? raw.size : 0,
    };
  }

  async function listFolder(driveUpn: string, folderPath: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let url: string | null = childrenUrl(driveUpn, folderPath);
    for (let guard = 0; guard < 100 && url; guard++) {
      const body: Record<string, unknown> = await graphJson(url);
      if (body['notFound']) return []; // missing folder ⇒ empty, never a throw (D5)
      const value = body['value'];
      if (!Array.isArray(value)) throw new FilesContractDriftError('children response missing "value" array');
      for (const raw of value) {
        const f = toDriveFile(raw as RawDriveItem);
        if (f) files.push(f);
      }
      const next = body['@odata.nextLink'];
      url = typeof next === 'string' ? next : null;
    }
    return files;
  }

  async function getFile(driveUpn: string, folderPath: string, fileName: string): Promise<DriveFile | null> {
    const files = await listFolder(driveUpn, folderPath);
    const target = fileName.toLowerCase();
    return files.find((f) => f.name.toLowerCase() === target) ?? null;
  }

  async function downloadFile(driveUpn: string, fileId: string): Promise<Uint8Array> {
    // /content is a 302 to a pre-authed download URL; fetch follows it by default.
    const res = await graphFetch(`${driveRoot(driveUpn)}/items/${encodeURIComponent(fileId)}/content`);
    if (!res.ok) throw new FilesContractDriftError(`download item ${fileId} → HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  return { mode: 'graph', listFolder, getFile, downloadFile };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** Strip query strings before a URL reaches a log (download URLs carry auth query state). */
function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}
