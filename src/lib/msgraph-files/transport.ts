// ADR-0049 D2/D4/D6 — the generic Graph Files transport interface + typed errors +
// mode selection.
//
// TWO implementations satisfy `FilesTransport`: `graphFilesTransport` (real,
// client-credentials, `Files.Read.All`) and `mockFilesTransport` (fixture-driven,
// the DEFAULT until the tenant grant + a real workbook file land).
// `selectFilesTransport()` picks by env presence and LOGS which one is active; the
// chosen `mode` is stamped into every `workbook_sync_runs` ledger row so
// mock-vs-live is never ambiguous. The transport is READ-ONLY: no write/move/delete
// method exists (the grant is `Files.Read.All`, and the workbook stays where it is).

import type { DriveFile, FilesTransportMode } from './types';

/**
 * The `Files.Read.All` application permission is missing / not consented — Graph
 * returns 403. This is D6/test-plan-8: the sync FAILS SOFT (log + ntfy + ledger
 * `forbidden`), never crashes. Distinct from a generic drift/transport error so the
 * engine can classify the run.
 */
export class FilesForbiddenError extends Error {
  override readonly name = 'FilesForbiddenError';
  constructor(message: string) {
    super(message);
  }
}

/** Token acquisition failed / 401 from Graph. Fatal for the run (classified `error`). */
export class FilesAuthFailedError extends Error {
  override readonly name = 'FilesAuthFailedError';
  constructor(message: string) {
    super(message);
  }
}

/** Graph returned a shape we do not understand (schema drift). Classified `error`. */
export class FilesContractDriftError extends Error {
  override readonly name = 'FilesContractDriftError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * The read-only contract the sync engine depends on. Kept minimal so the mock is a
 * faithful substitute.
 *
 * - `listFolder` returns the files in the owner's drive folder (used to discover the
 *   current month's file by naming pattern, D5). A missing folder is an empty list,
 *   never a throw.
 * - `getFile` resolves ONE file's metadata by name (the delta guard reads `ctag`).
 *   Returns null when the named file does not exist (a possibly-empty new-month
 *   state, D5) — never a throw.
 * - `downloadFile` returns the raw bytes for a file id.
 *
 * A missing `Files.Read.All` grant surfaces as {@link FilesForbiddenError} from any
 * method (the engine catches it and fails soft).
 */
export interface FilesTransport {
  readonly mode: FilesTransportMode;
  listFolder(driveUpn: string, folderPath: string): Promise<DriveFile[]>;
  getFile(driveUpn: string, folderPath: string, fileName: string): Promise<DriveFile | null>;
  downloadFile(driveUpn: string, fileId: string): Promise<Uint8Array>;
}

/** The four `MSGRAPH_FILES_*` values that must ALL be present to select the live transport. */
export interface GraphFilesConfig {
  tenantId: string;
  clientId: string;
  secret: string;
}

/**
 * Read the live-transport config, or null when ANY required value is missing — the
 * mock-selection signal. Values come from `~/.dr3-vision-secrets/msgraph-files.env`
 * (mounted optional). The AP transport already reads `MSGRAPH_MAIL_*`; the SAME app
 * registration carries `Files.Read.All`, so `MSGRAPH_FILES_*` FALLS BACK to the
 * `MSGRAPH_MAIL_*` tenant/client/secret when the Files-specific vars are unset —
 * one credential set, two capabilities (D6).
 */
export function readGraphFilesConfig(): GraphFilesConfig | null {
  const tenantId = (process.env['MSGRAPH_FILES_TENANT_ID'] ?? process.env['MSGRAPH_MAIL_TENANT_ID'])?.trim();
  const clientId = (process.env['MSGRAPH_FILES_CLIENT_ID'] ?? process.env['MSGRAPH_MAIL_CLIENT_ID'])?.trim();
  const secret = (process.env['MSGRAPH_FILES_SECRET'] ?? process.env['MSGRAPH_MAIL_SECRET'])?.trim();
  if (!tenantId || !clientId || !secret) return null;
  return { tenantId, clientId, secret };
}

export type FilesTransportLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
export const noopFilesTransportLog: FilesTransportLogger = () => undefined;
