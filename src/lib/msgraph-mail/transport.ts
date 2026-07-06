// ADR-0046 D1 — the generic Graph-mail transport interface + typed errors +
// mode selection.
//
// TWO implementations satisfy `MailTransport`: `graphTransport` (real,
// client-credentials) and `mockTransport` (fixture-driven, the DEFAULT until IT
// delivers creds). `selectTransport()` picks by env presence and LOGS which one
// is active — the mode is also stamped into every `ap_poll_runs` ledger row so
// mock-vs-live is never ambiguous. The transport NEVER sends: outbound decision
// mail is `sendSystemEmail` (C2); no Graph send permission exists.

import type { DeltaResult, MailMessage, NormAttachment, TransportMode } from './types';

/** Session is not authenticated (token acquisition failed, 401 from Graph). Fatal for the run. */
export class AuthFailedError extends Error {
  override readonly name = 'AuthFailedError';
  constructor(message: string) {
    super(message);
  }
}

/** Graph returned a shape we do not understand (schema drift / unexpected envelope). Fatal for the run. */
export class GraphContractDriftError extends Error {
  override readonly name = 'GraphContractDriftError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * The transport contract the AP pipeline depends on. Kept minimal so the mock is
 * a faithful substitute and the pipeline never touches Graph directly.
 *
 * `listDelta` takes the persisted delta token (null on first poll / after loss)
 * and returns the messages plus the NEW token to persist. `moveMessage` returns
 * the message's new Graph id (Graph re-issues it on move).
 */
export interface MailTransport {
  readonly mode: TransportMode;
  listDelta(folder: string, deltaToken: string | null): Promise<DeltaResult>;
  getMessage(id: string): Promise<MailMessage>;
  listAttachments(id: string): Promise<NormAttachment[]>;
  moveMessage(id: string, destFolder: string): Promise<string>;
}

/** The four `MSGRAPH_MAIL_*` values that must ALL be present to select the live transport. */
export interface GraphMailConfig {
  tenantId: string;
  clientId: string;
  secret: string;
  mailbox: string;
}

/**
 * Read the live-transport config, or null when ANY required value is missing —
 * the mock-selection signal. Values come from `~/.dr3-vision-secrets/msgraph-mail.env`
 * (mounted optional), so an unconfigured app selects the mock and boots fine.
 */
export function readGraphMailConfig(): GraphMailConfig | null {
  const tenantId = process.env['MSGRAPH_MAIL_TENANT_ID']?.trim();
  const clientId = process.env['MSGRAPH_MAIL_CLIENT_ID']?.trim();
  const secret = process.env['MSGRAPH_MAIL_SECRET']?.trim();
  const mailbox = process.env['MSGRAPH_MAIL_MAILBOX']?.trim();
  if (!tenantId || !clientId || !secret || !mailbox) return null;
  return { tenantId, clientId, secret, mailbox };
}

export type TransportLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
export const noopTransportLog: TransportLogger = () => undefined;
