// ADR-0046 Amendment 6 — shared inline-preview predicates (DESKTOP AP review).
//
// Single source of truth for "is this AP attachment safe to preview inline, and
// what Content-Type should the bytes be served as?" Used by BOTH the server route
// (`/api/ops/ap/[id]/attachment/[attId]`) and the client render branch
// (`ApQueueClient.tsx`) so the two can never drift.
//
// Why a filename fallback: MS Graph's `contentType` is persisted verbatim at ingest
// (`normalize.ts`), and some senders/relays mislabel PDFs as `application/octet-stream`
// (confirmed live: 2 of 41 file attachments) or parameterize as
// `application/pdf; name="inv.pdf"`. The old anchored `^application/pdf$` gate rejected
// both, hiding the Preview button entirely (download-only) — read by approvers as
// "can't see the invoice." We therefore (a) strip MIME parameters, and (b) for the
// ambiguous binary types (octet-stream / empty) fall back to the filename extension.
//
// Pure module — no server-only or Node imports — so the client may import it directly.

/** Strip `;`-parameters, trim, lowercase. `null`/`undefined`/empty → `''`. */
export function normalizeMime(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/** A binary/unknown type whose real nature must be inferred from the filename. */
function isAmbiguousBinary(mime: string): boolean {
  return mime === '' || mime === 'application/octet-stream';
}

function hasExt(filename: string | null | undefined, exts: readonly string[]): boolean {
  const name = (filename ?? '').toLowerCase();
  return exts.some((e) => name.endsWith(e));
}

/** Canonical inline-image MIME (note `image/jpg` is not a real MIME — map to jpeg). */
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp)$/;
const IMAGE_EXT_MIME: ReadonlyArray<readonly [string, string]> = [
  ['.png', 'image/png'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
];

/** Treat as an inline PDF: real `application/pdf` (params stripped), or an
 *  octet-stream/empty type whose filename ends in `.pdf`. */
export function isInlinePdf(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const mime = normalizeMime(contentType);
  if (mime === 'application/pdf') return true;
  return isAmbiguousBinary(mime) && hasExt(filename, ['.pdf']);
}

/** Treat as an inline image: a real `image/{png,jpeg,jpg,webp}` type, or an
 *  octet-stream/empty type whose filename has a matching image extension. */
export function isInlineImage(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const mime = normalizeMime(contentType);
  if (IMAGE_MIME_RE.test(mime)) return true;
  return isAmbiguousBinary(mime) && hasExt(filename, ['.png', '.jpeg', '.jpg', '.webp']);
}

export function isInlinePreviewable(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  return isInlinePdf(contentType, filename) || isInlineImage(contentType, filename);
}

/**
 * The Content-Type the bytes should be served as for an inline preview, or `null`
 * when the attachment is NOT inline-previewable (caller keeps a plain download).
 *
 * Returns a CANONICAL type even when the stored `content_type` was mislabeled — so
 * the presigned URL's `ResponseContentType` makes the browser render it (an
 * octet-stream `.pdf` served as `application/octet-stream; inline` would download,
 * not frame). This is the value the route both signs with and echoes to the client.
 */
export function effectiveInlineContentType(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): string | null {
  const mime = normalizeMime(contentType);
  if (isInlinePdf(contentType, filename)) return 'application/pdf';
  if (IMAGE_MIME_RE.test(mime)) return mime === 'image/jpg' ? 'image/jpeg' : mime;
  if (isAmbiguousBinary(mime)) {
    const hit = IMAGE_EXT_MIME.find(([ext]) => (filename ?? '').toLowerCase().endsWith(ext));
    if (hit) return hit[1];
  }
  return null;
}

// ── Presigned-URL freshness (ADR-0046 Amendment 6, defect 2) ─────────────────
//
// R2 GETs are minted short-lived. The client caches the URL on first expand; a
// reviewer who collapses then re-expands (or reads then clicks download) minutes
// later reuses an expired URL → R2 403 → blank iframe / dead link. We (a) raise the
// TTL and (b) re-mint when the cached URL is within `PRESIGN_STALE_SKEW_SECONDS` of
// expiry rather than caching forever.

/** AP attachment presigned-URL lifetime, seconds (was 300; raised for review pace). */
export const AP_ATTACHMENT_URL_TTL_SECONDS = 900;

/** Re-mint this many seconds BEFORE nominal expiry (clock skew + in-flight load). */
export const PRESIGN_STALE_SKEW_SECONDS = 60;

/** True when a URL minted at `mintedAtMs` with `expiresInSeconds` TTL should be
 *  re-minted before reuse. Defensive: a non-positive/absent TTL is always stale. */
export function isPresignStale(
  mintedAtMs: number,
  expiresInSeconds: number,
  nowMs: number = Date.now(),
): boolean {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return true;
  const freshMs = (expiresInSeconds - PRESIGN_STALE_SKEW_SECONDS) * 1000;
  return nowMs - mintedAtMs >= freshMs;
}
