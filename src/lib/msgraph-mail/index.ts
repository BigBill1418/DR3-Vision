// ADR-0046 — Graph-mail transport public surface.
//
// Consumers import from `@/lib/msgraph-mail` so the internal layout can evolve.
// `selectTransport()` picks the live or mock implementation by env presence and
// LOGS which one is active (D1: self-report at startup); the chosen `mode` is
// also stamped into every ap_poll_runs ledger row.

import { graphTransport } from './graph-transport';
import { mockTransport } from './mock-transport';
import { readGraphMailConfig, type MailTransport, type TransportLogger } from './transport';

/** Well-known source folder (Graph well-known name). */
export const SOURCE_FOLDER = process.env['MSGRAPH_MAIL_SOURCE_FOLDER']?.trim() || 'inbox';
/** Processed destination folder — a folder id or well-known name; the mailbox stays clean (C9-D6). */
export const PROCESSED_FOLDER = process.env['MSGRAPH_MAIL_PROCESSED_FOLDER']?.trim() || 'Processed';

/**
 * Select the transport: live `graphTransport` when all four MSGRAPH_MAIL_* values
 * are present, else the fixture-driven `mockTransport`. Logs the decision so the
 * operator can confirm mock-vs-live from the container log at boot / each poll.
 */
export function selectTransport(log?: TransportLogger): MailTransport {
  const config = readGraphMailConfig();
  if (config) {
    log?.('info', `[msgraph-mail] LIVE transport selected (mailbox=${config.mailbox})`);
    return graphTransport(config, { processedFolder: PROCESSED_FOLDER });
  }
  log?.('warn', '[msgraph-mail] MSGRAPH_MAIL_* not set — MOCK transport selected (fixture-driven, no live mail)');
  return mockTransport();
}

export { graphTransport } from './graph-transport';
export { mockTransport, type MockTransport, type MockTransportOptions, type MockMessageSpec } from './mock-transport';
export { loadDeltaToken, saveDeltaToken } from './delta-store';
export {
  AuthFailedError,
  GraphContractDriftError,
  readGraphMailConfig,
  type MailTransport,
  type GraphMailConfig,
  type TransportLogger,
} from './transport';
export {
  normalizeAttachment,
  normalizeAttachments,
  normalizeMessage,
  UnsupportedAttachmentError,
} from './normalize';
export { DEFAULT_MOCK_FIXTURES, SCRIPT_BEARING_HTML } from './__fixtures__/messages';
export type {
  MailMessage,
  DeltaResult,
  TransportMode,
  NormAttachment,
  NormFileAttachment,
  NormItemAttachment,
  NormReferenceAttachment,
} from './types';
