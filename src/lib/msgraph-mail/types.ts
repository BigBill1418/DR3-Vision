// ADR-0046 D1 — normalized Graph-mail transport types.
//
// This is a GENERIC inbound-mail capability (Morena's parked dispatch↔Outlook ask
// consumes it later); it is deliberately NOT scoped to AP. The normalized shapes
// below are what every consumer sees, regardless of whether the bytes came from
// the real Graph API (`graphTransport`) or fixtures (`mockTransport`). The raw
// Graph JSON is confined to `normalize.ts` + `graph-transport.ts`.

/** Which implementation produced a result — self-reported at startup + per run. */
export type TransportMode = 'mock' | 'graph';

/**
 * A normalized mail message. `internetMessageId` is the STABLE idempotency key
 * (it survives a folder move); the Graph `id` does NOT (Graph re-issues it on
 * move), so all per-message work (attachments, persist, move) uses the `id` from
 * the SAME poll before the message is relocated.
 *
 * `from` is the authenticated envelope sender, lowercased — the auth subject.
 * For a forwarded vendor invoice this is the internal FORWARDER, never the vendor
 * address inside the body (C10.4). Display name is captured separately and is
 * NEVER an auth input.
 */
export interface MailMessage {
  id: string;
  internetMessageId: string;
  conversationId: string | null;
  receivedDateTime: string; // ISO-8601
  from: string; // lowercased authenticated sender address
  fromName: string | null; // display name — context only, never an auth input
  subject: string | null;
  bodyHtml: string | null; // RAW email HTML — sanitized at ingest, never rendered as-is
  bodyText: string | null; // text/plain part
  hasAttachments: boolean;
}

/** A downloaded file attachment (fileAttachment, or a one-level-unwrapped itemAttachment file). */
export interface NormFileAttachment {
  kind: 'file';
  id: string;
  name: string | null;
  contentType: string | null;
  size: number | null;
  /** base64 bytes — streamed to R2 by the pipeline, NEVER logged. */
  contentBytesBase64: string | null;
}

/**
 * A nested forwarded message (itemAttachment). Unwrapped ONE level: its subject +
 * its own file attachments. `hasDeeperNesting` marks an item-within-item so the
 * queue can show a "nested message" marker without Vision recursing (C10.3).
 */
export interface NormItemAttachment {
  kind: 'nested_message';
  id: string;
  name: string | null;
  nestedSubject: string | null;
  nestedFiles: NormFileAttachment[];
  hasDeeperNesting: boolean;
}

/** An OneDrive/SharePoint link (referenceAttachment). Recorded for the approver, NEVER fetched. */
export interface NormReferenceAttachment {
  kind: 'reference_link';
  id: string;
  name: string | null;
  sourceUrl: string | null;
}

export type NormAttachment = NormFileAttachment | NormItemAttachment | NormReferenceAttachment;

/**
 * The result of one delta list. `deltaToken` is the token to PERSIST for the next
 * poll. `resynced` is true when we performed a full-folder resync (no prior token,
 * or the stored token was rejected/expired) — idempotency (internetMessageId
 * UNIQUE) absorbs the re-list, and the ledger records it.
 */
export interface DeltaResult {
  messages: MailMessage[];
  deltaToken: string;
  resynced: boolean;
}
