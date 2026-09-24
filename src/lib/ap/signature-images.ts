// Which AP attachments are the forwarder's signature / logo images rather than a
// document. Shared by the decision stamp (ADR-0046, which must not stamp a logo and
// mail it as the invoice) and the same-file duplicate key (ADR-0136 addendum, which
// must not call two unrelated invoices "the same file" because Gloria's signature
// logo rides on both).

import { normalizeMime } from './inline-preview';

export interface AttachmentShape {
  filename: string | null;
  content_type: string | null;
  byte_size: number | null;
}

/**
 * Inline-image heuristic (ADR-0046 post-amendment, 2026-07-15). Forwards drag in
 * signature/logo images (`image/*`, a few KB) that must not be stamped and mailed
 * as if they were the invoice. We have no exact inline signal yet — `normalizeFile`
 * (msgraph-mail/normalize.ts) drops Graph's `isInline`/`contentId`, so `ap_attachments`
 * carries no inline column. Ship-now proxy: exclude tiny images (`image/*` AND
 * byte_size < 50 KB); a scanned/photographed invoice is virtually always >200 KB,
 * logos/signatures <20 KB. PDFs and non-image files are ALWAYS kept regardless of size.
 * Durable follow-up: capture `isInline`+`contentId` into a new `ap_attachments.is_inline`
 * column and filter on that exactly (retiring this size heuristic) — see ADR-0046.
 */
const INLINE_IMAGE_MAX_BYTES = 50_000;
export function isLikelyInlineImage(a: AttachmentShape): boolean {
  // ADR-0132 D2 — normalized, so a parameterized or whitespace-padded
  // `image/jpeg; name="sig.jpg"` is still recognized as the signature logo it is.
  const ct = normalizeMime(a.content_type);
  return ct.startsWith('image/') && a.byte_size != null && a.byte_size < INLINE_IMAGE_MAX_BYTES;
}

/**
 * Outlook names every image pasted into a message body `image001.jpg`,
 * `image002.png`, … Production (2026-09-23): the same 69,918-byte and 80,204-byte
 * `image00N.jpg` signature logos ride on 12 and 7 different approved requests —
 * above the 50 KB line, so the size rule alone keeps them. A vendor's photographed
 * invoice arrives under its own name (`5312.jpg`, `Service_Order_Attachment_1_image.jpg`).
 */
const OUTLOOK_BODY_IMAGE = /^image\d+\.(?:png|jpe?g|gif|bmp)$/i;

/** A signature/logo image by either rule — never a key for "the same invoice file". */
export function isSignatureImage(a: AttachmentShape): boolean {
  return (
    isLikelyInlineImage(a) ||
    (normalizeMime(a.content_type).startsWith('image/') &&
      OUTLOOK_BODY_IMAGE.test(a.filename ?? ''))
  );
}
