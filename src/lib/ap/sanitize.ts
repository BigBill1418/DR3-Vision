// ADR-0046 C10.2 — server-side HTML sanitization (NON-NEGOTIABLE).
//
// Email HTML is untrusted input that would otherwise render inside an
// authenticated dashboard = a stored-XSS path into an approver's session. We
// sanitize with an allowlist (`sanitize-html`) AT INGEST and store only the
// result in `ap_requests.body_html_sanitized`; the raw HTML is NEVER stored for
// render and never executes in the app origin. The queue additionally renders
// the sanitized HTML inside a sandboxed <iframe> (belt-and-suspenders) — but THIS
// is the primary control. Regression test (sanitize.test.ts) asserts a
// script/onerror/iframe/style-url fixture renders inert.

import sanitizeHtml from 'sanitize-html';

// A deliberately conservative allowlist: formatting + tables + links + images
// (invoice emails are often image- or table-heavy). NO script/iframe/object/
// embed/form/style tags; NO event handlers; NO style attribute (kills the
// `style="background:url(javascript:…)"` vector); links + images restricted to
// http/https/mailto schemes (kills `javascript:`/`data:` URIs).
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
    'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan', 'align'],
    th: ['colspan', 'rowspan', 'align', 'scope'],
    table: ['border', 'cellpadding', 'cellspacing'],
    col: ['span'],
  },
  // Schemes for hrefs / src. Excludes javascript: and data: entirely.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  // A relative href/src has no scheme; disallow (nothing in-app should resolve them).
  allowProtocolRelative: false,
  // Strip <style> content and any disallowed tag's text? Keep text of unknown tags
  // (e.g. a stray <font>) but drop the tag; drop script/style bodies entirely.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  disallowedTagsMode: 'discard',
  // Harden every surviving link: open away from the app + no referrer/opener.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
  },
};

/**
 * Sanitize untrusted email HTML into inert, allowlisted HTML safe to render.
 * Returns '' for null/empty input. Pure + deterministic.
 */
export function sanitizeEmailHtml(rawHtml: string | null | undefined): string {
  if (!rawHtml) return '';
  return sanitizeHtml(rawHtml, OPTIONS);
}
