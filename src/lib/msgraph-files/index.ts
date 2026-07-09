// ADR-0049 — Graph Files transport public surface.
//
// Consumers import from `@/lib/msgraph-files`. `selectFilesTransport()` picks the
// live or mock implementation by env presence and LOGS which one is active (D1
// discipline); the chosen `mode` is stamped into every workbook_sync_runs row.

import { graphFilesTransport } from './graph-transport';
import { mockFilesTransport, type MockFileSpec } from './mock-transport';
import { buildFixtureWorkbookBytes } from './__fixtures__/workbook';
import { readGraphFilesConfig, type FilesTransport, type FilesTransportLogger } from './transport';

/**
 * Select the transport: live `graphFilesTransport` when the MSGRAPH_FILES_* (or the
 * shared MSGRAPH_MAIL_*) creds are present, else the fixture-driven
 * `mockFilesTransport` seeded with the default June-Woodland workbook under the
 * default naming pattern. Logs the decision so the operator can confirm mock-vs-live
 * from the container log.
 */
export async function selectFilesTransport(
  log?: FilesTransportLogger,
  opts: { fixtureFileName?: string } = {},
): Promise<FilesTransport> {
  const config = readGraphFilesConfig();
  if (config) {
    log?.('info', '[msgraph-files] LIVE transport selected (Files.Read.All client-credentials)');
    return graphFilesTransport(config);
  }
  const bytes = await buildFixtureWorkbookBytes();
  const files: MockFileSpec[] = [
    { id: 'mock-june-woodland', name: opts.fixtureFileName ?? 'JUNE 2026 DAILY LOG WOODLAND.xlsm', ctag: 'ctag-v1', bytes },
  ];
  log?.('warn', '[msgraph-files] MSGRAPH_FILES_*/MSGRAPH_MAIL_* not set — MOCK transport selected (fixture workbook, no live drive)');
  return mockFilesTransport({ files });
}

export { graphFilesTransport } from './graph-transport';
export { mockFilesTransport, type MockFilesTransport, type MockFilesTransportOptions, type MockFileSpec } from './mock-transport';
export {
  buildFixtureWorkbookBytes,
  DEFAULT_FIXTURE_SPEC,
  type FixtureWorkbookSpec,
  type FixtureDailyRow,
} from './__fixtures__/workbook';
export {
  FilesForbiddenError,
  FilesAuthFailedError,
  FilesContractDriftError,
  readGraphFilesConfig,
  noopFilesTransportLog,
  type FilesTransport,
  type GraphFilesConfig,
  type FilesTransportLogger,
} from './transport';
export type { DriveFile, FilesTransportMode } from './types';
