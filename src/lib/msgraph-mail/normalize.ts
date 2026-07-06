// ADR-0046 C10.3 — pure normalizers for the raw Graph attachment taxonomy.
//
// Confines every raw Graph JSON shape to this module (fixture-tested, no network).
// `graphTransport` calls these; `mockTransport` returns already-normalized shapes.
// The complete taxonomy: fileAttachment / itemAttachment (unwrap ONE level) /
// referenceAttachment. An UNKNOWN @odata.type is a per-message parse failure the
// pipeline quarantines (never a silent drop, never a whole-run crash).

import type {
  MailMessage,
  NormAttachment,
  NormFileAttachment,
  NormReferenceAttachment,
} from './types';

const FILE_TYPE = '#microsoft.graph.fileAttachment';
const ITEM_TYPE = '#microsoft.graph.itemAttachment';
const REF_TYPE = '#microsoft.graph.referenceAttachment';

/** Thrown for an attachment @odata.type we do not model — caught per-message → quarantine. */
export class UnsupportedAttachmentError extends Error {
  override readonly name = 'UnsupportedAttachmentError';
  constructor(readonly odataType: string) {
    super(`unsupported attachment @odata.type: ${odataType || '(missing)'}`);
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface RawAttachment {
  '@odata.type'?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
  sourceUrl?: string;
  item?: RawItem;
}
interface RawItem {
  '@odata.type'?: string;
  subject?: string;
  attachments?: RawAttachment[];
}

function normalizeFile(raw: RawAttachment): NormFileAttachment {
  return {
    kind: 'file',
    id: str(raw.id) ?? '',
    name: str(raw.name),
    contentType: str(raw.contentType),
    size: num(raw.size),
    contentBytesBase64: str(raw.contentBytes),
  };
}

function normalizeReference(raw: RawAttachment): NormReferenceAttachment {
  return {
    kind: 'reference_link',
    id: str(raw.id) ?? '',
    name: str(raw.name),
    sourceUrl: str(raw.sourceUrl),
  };
}

/**
 * Normalize one raw Graph attachment. `itemAttachment` is unwrapped ONE level:
 * its subject + its own FILE attachments become first-class; a nested
 * itemAttachment inside it sets `hasDeeperNesting` (stored as-is with a marker,
 * never recursed). Throws `UnsupportedAttachmentError` for an unknown type.
 */
export function normalizeAttachment(raw: RawAttachment): NormAttachment {
  const type = raw['@odata.type'] ?? '';
  if (type === FILE_TYPE) return normalizeFile(raw);
  if (type === REF_TYPE) return normalizeReference(raw);
  if (type === ITEM_TYPE) {
    const inner = raw.item?.attachments ?? [];
    const nestedFiles: NormFileAttachment[] = [];
    let hasDeeperNesting = false;
    for (const a of inner) {
      const t = a['@odata.type'] ?? '';
      if (t === FILE_TYPE) nestedFiles.push(normalizeFile(a));
      else if (t === ITEM_TYPE) hasDeeperNesting = true;
      // referenceAttachment nested inside a forwarded message is display-only
      // context at this depth; we surface the item marker, not the link.
    }
    return {
      kind: 'nested_message',
      id: str(raw.id) ?? '',
      name: str(raw.name),
      nestedSubject: str(raw.item?.subject),
      nestedFiles,
      hasDeeperNesting,
    };
  }
  throw new UnsupportedAttachmentError(type);
}

export function normalizeAttachments(raws: readonly RawAttachment[]): NormAttachment[] {
  return raws.map(normalizeAttachment);
}

// ── Message normalization ────────────────────────────────────────────────

interface RawEmailAddress {
  address?: string;
  name?: string;
}
interface RawMessage {
  id?: string;
  internetMessageId?: string;
  conversationId?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: RawEmailAddress };
  sender?: { emailAddress?: RawEmailAddress };
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  hasAttachments?: boolean;
}

/**
 * Normalize a raw Graph message into `MailMessage`. The authenticated sender is
 * `from` (falling back to `sender`), lowercased. `bodyHtml` / `bodyText` are set
 * from the body by its contentType; the caller may supplement `bodyText` with a
 * separate text-part fetch. Throws `GraphContractDriftError`-worthy conditions
 * are the caller's concern — this pure fn tolerates missing optional fields.
 */
export function normalizeMessage(raw: RawMessage): MailMessage {
  const addr = str(raw.from?.emailAddress?.address) ?? str(raw.sender?.emailAddress?.address) ?? '';
  const bodyType = (raw.body?.contentType ?? '').toLowerCase();
  const content = str(raw.body?.content);
  const isHtml = bodyType === 'html';
  return {
    id: str(raw.id) ?? '',
    internetMessageId: str(raw.internetMessageId) ?? '',
    conversationId: str(raw.conversationId),
    receivedDateTime: str(raw.receivedDateTime) ?? new Date(0).toISOString(),
    from: addr.toLowerCase(),
    fromName: str(raw.from?.emailAddress?.name) ?? str(raw.sender?.emailAddress?.name),
    subject: str(raw.subject),
    bodyHtml: isHtml ? content : null,
    bodyText: isHtml ? str(raw.bodyPreview) : (content ?? str(raw.bodyPreview)),
    hasAttachments: raw.hasAttachments === true,
  };
}

export type { RawAttachment, RawMessage };
